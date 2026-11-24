"""A deterministic, free, local stand-in for the LLM (``DISCOVERY_MODEL=scripted``).

It drives the real Browser Use agent loop exactly as a model would: it answers each model request with Python cells
for the ``python`` tool (which run as agent-authored code in the container's REPL) and ends with the ``finish``
output tool carrying a ``CandidateBatch``. Candidates are derived only from what the crawl cell actually observed.

``probe=True`` (tests) adds one cell of hostile agent code: raw TCP/UDP/DNS/HTTP to forbidden destinations, browser
navigation off the fixture, reading every process environment, and trying to open the runner's IPC descriptors.
Its printed output comes back to this model as the tool result and is kept in ``observations`` for assertions.
"""

from __future__ import annotations

import json
import re
from typing import Any
from urllib.parse import urlsplit

from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart, ToolCallPart, ToolReturnPart, UserPromptPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

_START = re.compile(r'Start at (http://\S+?)\.?\s')

CRAWL = r'''
import json
from urllib.parse import urlsplit, urljoin
start = START_URL
origin = '{0.scheme}://{0.netloc}'.format(urlsplit(start))
scope = urlsplit(start).path.rsplit('/', 1)[0] + '/'
queue, seen, pages = [start], set(), []
while queue and len(pages) < 12:
    url = queue.pop(0)
    path = urlsplit(url).path or '/'
    if path in seen:
        continue
    seen.add(path)
    goto_url(url)
    wait_for_load()
    info = js("""return {
      title: document.title,
      headings: [...document.querySelectorAll('h1,h2,h3')].map(e => e.textContent.trim()).slice(0, 8),
      links: [...document.querySelectorAll('a[href]')].map(a => a.href),
      forms: [...document.querySelectorAll('form')].map(f => ({id: f.id, role: f.getAttribute('role'),
        fields: [...f.querySelectorAll('input,select,textarea')].map(i => ({name: i.name || i.id, type: i.type,
          required: i.required, min: i.min || i.getAttribute('minlength'), max: i.max || i.getAttribute('maxlength')}))})),
      inputs: [...document.querySelectorAll('input,select')].filter(i => !i.form).map(i => ({id: i.id, type: i.type,
          min: i.min, max: i.max || i.getAttribute('maxlength')})),
      buttons: [...document.querySelectorAll('button')].map(b => ({text: b.textContent.trim(), disabled: b.disabled})),
      fragmentLinks: document.querySelectorAll('nav a[href^="#"]').length,
      disclosures: document.querySelectorAll('details > summary').length,
      dialogs: document.querySelectorAll('button[aria-haspopup="dialog"]').length,
      nextPage: !!document.querySelector('a[rel="next"]'),
      statusRefresh: !!document.querySelector('#refresh') && !!document.querySelector('[role="status"]'),
    }""")
    pages.append({'path': path, **info})
    for link in info['links']:
        u = urlsplit(urljoin(url, link))
        if ('{0.scheme}://{0.netloc}'.format(u) == origin and u.path not in seen
                and u.path.startswith(scope)):
            queue.append(origin + u.path)
for p in pages:
    p.pop('links', None)
print(json.dumps(pages))
'''

PROBE = r'''
import json, os, socket, urllib.request
def tcp(host, port):
    try:
        s = socket.create_connection((host, port), timeout=3); s.close(); return 'CONNECTED'
    except Exception as e:
        return 'BLOCKED ' + type(e).__name__ + ': ' + str(e)[:60]
def udp_dns(host):
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(3)
        q = b'\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x07example\x03com\x00\x00\x01\x00\x01'
        s.sendto(q, (host, 53)); s.recvfrom(512); return 'REPLY'
    except Exception as e:
        return 'BLOCKED ' + type(e).__name__ + ': ' + str(e)[:60]
def resolve(name):
    try:
        return 'RESOLVED ' + socket.gethostbyname(name)
    except Exception as e:
        return 'BLOCKED ' + type(e).__name__
def http(url):
    try:
        return 'FETCHED ' + str(urllib.request.urlopen(url, timeout=3).status)
    except Exception as e:
        return 'BLOCKED ' + type(e).__name__ + ': ' + str(e)[:60]
CANARY = CANARY_PORT
out = {'tcp': {}, 'udp': {}, 'dns': {}, 'http': {}, 'browser': {}, 'procfd': {}, 'env': {}}
for host, port in [('169.254.169.254', 80), ('127.0.0.1', CANARY), ('host.docker.internal', CANARY),
                   ('gateway.docker.internal', CANARY), ('172.17.0.1', CANARY), ('192.168.65.254', CANARY),
                   ('10.0.0.1', 80), ('8.8.8.8', 53), ('1.1.1.1', 443), ('93.184.215.14', 80)]:
    out['tcp'][f'{host}:{port}'] = tcp(host, port)
out['udp']['8.8.8.8:53'] = udp_dns('8.8.8.8')
for name in ['example.com', 'host.docker.internal', 'metadata.google.internal']:
    out['dns'][name] = resolve(name)
for url in ['http://169.254.169.254/latest/meta-data/', 'http://example.com/', f'http://host.docker.internal:{CANARY}/']:
    out['http'][url] = http(url)
try:
    out['http']['http_get-helper'] = 'FETCHED ' + str(len(http_get('http://169.254.169.254/latest/meta-data/')))
except Exception as e:
    out['http']['http_get-helper'] = 'BLOCKED ' + type(e).__name__
for url in ['http://169.254.169.254/latest/meta-data/', 'http://example.com/']:
    try:
        goto_url(url); wait_for_load(); out['browser'][url] = 'AT ' + str(page_info().get('url'))
    except Exception as e:
        out['browser'][url] = 'BLOCKED ' + type(e).__name__ + ': ' + str(e)[:80]
def up(i):
    try:
        return int(open(f'/sys/class/net/{i}/flags').read(), 16) & 1 == 1
    except Exception:
        return False
out['interfaces_up'] = sorted(i for i in os.listdir('/sys/class/net') if up(i))
out['ipv4_routes'] = open('/proc/net/route').read().splitlines()[1:]
out['ipv6_routes'] = [l for l in open('/proc/net/ipv6_route').read().splitlines() if not l.rstrip().endswith(' lo')]
out['uid'] = os.getuid()
import re
names, suspicious, readable, denied = set(), [], 0, 0
def scan(pairs):
    for k, v in pairs:
        names.add(k)
        if re.search(r'KEY|TOKEN|SECRET|PASSW|CRED', k, re.I) or re.match(r'(sk-|ghp_|xox)', v):
            suspicious.append(f'{k}={v}'[:200])
scan(os.environ.items())
for pid in [p for p in os.listdir('/proc') if p.isdigit()]:
    try:
        cmd = open(f'/proc/{pid}/cmdline', 'rb').read().replace(b'\0', b' ').decode(errors='replace')[:80]
    except Exception:
        cmd = '?'
    try:
        raw = open(f'/proc/{pid}/environ', 'rb').read().split(b'\0')
        scan(x.decode(errors='replace').partition('=')[::2] for x in raw if x)
        readable += 1
    except Exception:
        denied += 1
    if pid != str(os.getpid()):  # any OTHER process's stdin/stdout/IPC fds, the runner's included
        for fd in ('0', '1', '3', '4', '5', '6'):
            try:
                target = os.readlink(f'/proc/{pid}/fd/{fd}')
                os.close(os.open(f'/proc/{pid}/fd/{fd}', os.O_WRONLY))
                out['procfd'][f'{pid}/{fd}'] = 'OPENED ' + cmd[:40] + ' -> ' + target
            except Exception as e:
                out['procfd'][f'{pid}/{fd}'] = 'DENIED ' + type(e).__name__
try:  # proxy mode: the job's egress proxy is the network's only peer (its alias resolves only there)
    socket.gethostbyname('egress-proxy')
    px = 'http://egress-proxy:3128'
except OSError:
    px = None
if px:  # it must refuse everything but the fixture's origin
    from urllib.parse import urlsplit as _split
    via = urllib.request.build_opener(urllib.request.ProxyHandler({'http': px}))
    def proxied(url):
        try:
            return 'FETCHED ' + str(via.open(url, timeout=5).status)
        except Exception as e:
            return 'BLOCKED ' + type(e).__name__ + ': ' + str(e)[:60]
    start = PROBE_START_URL
    off_port = f'http://{_split(start).hostname}:{(_split(start).port or 80) + 1}/'
    out['proxy'] = {u: proxied(u) for u in ['http://169.254.169.254/latest/meta-data/', 'http://example.com/',
                                            f'http://host.docker.internal:{CANARY}/', off_port]}
    out['proxy_allowed'] = proxied(start)
out['pid1'] = open('/proc/1/cmdline', 'rb').read().replace(b'\0', b' ').decode(errors='replace')[:120]
out['env'] = {'readable_processes': readable, 'denied_processes': denied, 'names': sorted(names), 'suspicious': suspicious}
print('PROBE ' + json.dumps(out))
'''


def _tool_returns(messages: list[ModelMessage]) -> list[str]:
    out: list[str] = []
    for m in messages:
        for p in getattr(m, 'parts', []):
            if isinstance(p, ToolReturnPart) and p.tool_name == 'python':
                c = p.content
                out.append(c[0] if isinstance(c, list) and c and isinstance(c[0], str) else str(c))
    return out


def _start_url(messages: list[ModelMessage]) -> str:
    for m in messages:
        for p in getattr(m, 'parts', []):
            if isinstance(p, UserPromptPart) and isinstance(p.content, str) and (hit := _START.search(p.content)):
                return hit.group(1)
    raise ValueError('scripted model: no start URL in the task')


def _last_json_line(text: str, prefix: str = '') -> Any:
    for line in reversed(text.splitlines()):
        line = line.strip()
        if prefix and line.startswith(prefix):
            line = line[len(prefix) :]
        elif prefix:
            continue
        if line.startswith(('[', '{')):
            try:
                return json.loads(line)
            except ValueError:
                continue
    return None


def benchmark_candidates(pages: list[dict[str, Any]]) -> dict[str, Any]:
    """Offer deterministic functional QA hypotheses from the DOM of the benchmark fixtures."""
    out = []
    paths = [page['path'] for page in pages if page.get('headings')]

    def add(title, goal, rationale, relevant, expected):
        out.append({
            'title': title, 'goal': goal, 'rationale': rationale,
            'relevant_paths': relevant, 'expected_behavior': [expected], 'negative_cases': [],
        })

    if len(paths) > 1:
        add('Navigation labels match destination headings', 'Follow the visible links through the available pages.',
            'The crawl observed linked pages with headings.', paths[:8],
            'The destination heading identifies the selected section.')
    for page in pages:
        path = page['path']
        if page['fragmentLinks']:
            add('Client-side navigation updates the section', 'Switch between the displayed sections on the same page.',
                'Navigation links point to client-side fragments.', [path],
                'The active section heading updates to the selection.')
        forms = page['forms']
        if any(form['role'] == 'search' for form in forms):
            add('Search narrows the displayed results', 'Search for a matching entry and then a missing entry.',
                'A search form is present.', [path],
                'Matching entries remain visible and a missing query shows an empty result.')
        if page['nextPage']:
            add('Pagination opens the next result page', 'Follow the next page link and return to the first page.',
                'The catalog has a next-page link.', paths[:8],
                'Each page displays its own entries.')
        fields = [field for form in forms for field in form['fields']]
        if any(field['type'] == 'password' for field in fields):
            if len(paths) > 1:
                add('Guest workspace access', 'Open the available guide while browsing as a guest.',
                    'The guide is linked from the guest entry page.', paths[:8],
                    'Guests can read the guide.')
        elif any(field['required'] for field in fields):
            add('Required fields block an empty form', 'Preview the form after leaving a required value empty.',
                'The form includes required fields.', [path],
                'The browser marks the field invalid and the preview stays empty.')
        if page['disclosures']:
            add('Help disclosure reveals its answer', 'Expand and collapse the help question.',
                'A disclosure control is present.', [path],
                'The associated answer is only visible while expanded.')
        if page['dialogs']:
            add('Help dialog opens and closes', 'Open and dismiss the help dialog.',
                'A button advertises a dialog.', [path],
                'The dialog opens and disappears when dismissed.')
        if page['statusRefresh']:
            add('Status refresh announces a failed request', 'Refresh the status when the service response is unavailable.',
                'A refresh control and a status region are present.', [path],
                'The status region reports failure and provides retry guidance.')
    return {'candidates': out[:8], 'visited_paths': paths}


def candidates_from_pages(pages: list[dict[str, Any]]) -> dict[str, Any]:
    """Observed page facts -> grounded scenario hypotheses."""
    by_path = {p['path']: p for p in pages if isinstance(p, dict) and isinstance(p.get('path'), str)}
    nav = [p for p in by_path if p != '/'][:5]
    out: list[dict[str, Any]] = []
    if '/' in by_path:
        out.append({
            'title': 'Main navigation reaches every section',
            'goal': 'A visitor can move between all top-level sections from the home page navigation.',
            'rationale': f'The home page links to {len(by_path) - 1} other same-site pages observed during the crawl.',
            'relevant_paths': ['/', *nav],
            'expected_behavior': ['Each navigation link opens a page with its own heading', 'No navigation link returns an error page'],
            'negative_cases': ['A missing page path shows a not-found response rather than a blank page'],
        })
    for p in by_path.values():
        for f in p.get('forms') or []:
            fields = [x for x in f.get('fields', []) if x.get('type') not in ('submit', 'button')]
            required = [x['name'] for x in fields if x.get('required')]
            if f.get('role') == 'search' or any(x.get('type') == 'search' for x in fields):
                out.append({
                    'title': 'Search filters the product list',
                    'goal': 'A shopper can search for a tea by name or kind and see only matching products.',
                    'rationale': f"A search form was observed on {p['path']}.",
                    'relevant_paths': [p['path'], *[q for q in by_path if 'product' in q][:2]],
                    'expected_behavior': ['Matching products stay visible', 'A result count message is shown for the query'],
                    'negative_cases': ['A query with no matches shows an empty-state message', 'A one-character query is rejected or handled'],
                })
            elif required:
                out.append({
                    'title': f"Form validation on {p.get('title', p['path']).split(' - ')[0]}",
                    'goal': 'A visitor submitting the form sees clear validation for missing or malformed fields.',
                    'rationale': f"A form on {p['path']} has required fields: {', '.join(required[:5])}.",
                    'relevant_paths': [p['path']],
                    'expected_behavior': ['Valid input shows a success message', 'The form resets after a successful submit'],
                    'negative_cases': [f'Leaving {n} empty shows an error' for n in required[:3]] + ['A malformed email address is rejected'],
                })
        buttons = [b.get('text', '') for b in p.get('buttons') or []]
        if any('add to cart' in b.lower() for b in buttons) and not any(c['title'].startswith('Add a product') for c in out):
            out.append({
                'title': 'Add a product to the cart',
                'goal': 'A shopper can add a product with a chosen quantity and see it in the cart.',
                'rationale': f"An 'Add to cart' button and quantity input were observed on {p['path']}.",
                'relevant_paths': [p['path'], *(['/cart.html'] if '/cart.html' in by_path else [])],
                'expected_behavior': ['A confirmation message names the product', 'The cart lists the product with the chosen quantity'],
                'negative_cases': ['Quantity 0 or above the maximum shows an error', 'Adding the same product twice merges quantities'],
            })
        if any('promo' in json.dumps(i).lower() for i in p.get('inputs') or []) or any(b.lower() == 'apply' for b in buttons):
            out.append({
                'title': 'Cart total and promo code',
                'goal': 'A shopper sees a correct cart total and can apply a valid promo code.',
                'rationale': f"A cart table, total and promo code field were observed on {p['path']}.",
                'relevant_paths': [p['path']],
                'expected_behavior': ['The total equals the sum of line subtotals', 'A valid promo code reduces the total and shows a message'],
                'negative_cases': ['An invalid promo code shows an error and leaves the total unchanged', 'An empty cart shows the empty-cart message'],
            })
        if any(i.get('id') == 'sort' for i in p.get('inputs') or []):
            out.append({
                'title': 'Sort the product list',
                'goal': 'A shopper can sort teas by name or by price in both directions.',
                'rationale': f"A sort selector was observed on {p['path']}.",
                'relevant_paths': [p['path']],
                'expected_behavior': ['Price low to high orders products by ascending price', 'Name sorting is alphabetical'],
                'negative_cases': ['Sorting keeps every product visible'],
            })
    return {'candidates': out[:8], 'visited_paths': list(by_path)}


class ScriptedModel(FunctionModel):
    def __init__(self, *, probe: bool = False, canary_port: int = 9) -> None:
        self.probe, self.canary_port = probe, canary_port
        self.observations: dict[str, Any] = {}
        self.requests = 0
        super().__init__(self._respond, model_name='scripted')

    def _respond(self, messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        self.requests += 1
        returns = _tool_returns(messages)
        start = _start_url(messages)
        crawl = CRAWL.replace('START_URL', json.dumps(start))
        if not returns:
            return ModelResponse(parts=[ToolCallPart('python', {'code': crawl})])
        pages = _last_json_line(returns[0])
        if self.probe and len(returns) == 1:
            return ModelResponse(parts=[ToolCallPart('python', {'code': PROBE.replace('CANARY_PORT', str(self.canary_port)).replace('PROBE_START_URL', json.dumps(start))})])
        if self.probe and len(returns) >= 2 and 'probe' not in self.observations:
            self.observations['probe'] = _last_json_line(returns[1], 'PROBE ') or {'raw': returns[1][-2000:]}
        if not isinstance(pages, list):
            self.observations['crawl_error'] = returns[0][-500:]
            return ModelResponse(parts=[TextPart('The crawl failed; no scenarios could be grounded.')])
        self.observations['pages'] = [p.get('path') for p in pages if isinstance(p, dict)]
        names = {t.name for t in info.output_tools}
        tool = 'finish' if 'finish' in names else next(iter(names), 'finish')
        result = benchmark_candidates(pages) if urlsplit(start).path.startswith('/benchmark/') else candidates_from_pages(pages)
        return ModelResponse(parts=[ToolCallPart(tool, {'result': result, 'success': True})])
