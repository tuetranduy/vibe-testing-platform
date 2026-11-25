import json

import pytest

from discovery_service.policy import fixture_paths
from discovery_service.launcher import SITE_DIR, to_response
from discovery_service.protocol import (
    MAX_CANDIDATES,
    DiscoveryResponse,
    FrameError,
    decode_frame,
    encode_frame,
    parse_request,
    sanitize_candidates,
)

KNOWN = fixture_paths(SITE_DIR)


def cand(**kw):
    base = {
        'title': 'Add a product to the cart',
        'goal': 'A shopper can add a product and see it in the cart.',
        'rationale': 'Add to cart button observed.',
        'relevant_paths': ['/product-assam.html', '/cart.html'],
        'expected_behavior': ['Cart lists the product'],
        'negative_cases': ['Quantity 0 is rejected'],
    }
    base.update(kw)
    return base


def test_parse_request_accepts_exact_shape():
    r = parse_request(b'{"schemaVersion":"discovery.v1","runId":"run_1-A","targetUrl":"http://127.0.0.1:4599/"}\n')
    assert r.runId == 'run_1-A'


def test_discovery_limits_accept_extended_job_budget():
    base = {'schemaVersion': 'discovery.v1', 'runId': 'r', 'targetUrl': 'http://x/'}
    request = parse_request(json.dumps(dict(base, timeoutSeconds=360, maxAgentSteps=60)).encode())
    assert (request.timeoutSeconds, request.maxAgentSteps) == (360, 60)
    for field, value in [('timeoutSeconds', 361), ('maxAgentSteps', 1)]:
        with pytest.raises(ValueError):
            parse_request(json.dumps(dict(base, **{field: value})).encode())


@pytest.mark.parametrize('raw', [
    b'',
    b'not json',
    b'{"schemaVersion":"discovery.v2","runId":"r","targetUrl":"http://x/"}',
    b'{"schemaVersion":"discovery.v1","runId":"r.1","targetUrl":"http://x/"}',  # runId charset
    b'{"schemaVersion":"discovery.v1","runId":"' + b'a' * 129 + b'","targetUrl":"http://x/"}',
    b'{"schemaVersion":"discovery.v1","runId":"r","targetUrl":"http://x/","limits":{"maxAgentSteps":99}}',
    b'{"schemaVersion":"discovery.v1","runId":"r","targetUrl":"http://x/"}\n{"again":1}',
    b'{"schemaVersion":"discovery.v1","runId":"r","targetUrl":"' + b'a' * 20000 + b'"}',
])
def test_parse_request_rejects(raw):
    with pytest.raises(ValueError):
        parse_request(raw)


def test_fixture_paths():
    assert {'/', '/cart.html', '/contact.html', '/products.html'} <= KNOWN
    assert '/index.html' not in KNOWN


def test_sanitize_keeps_grounded_candidate():
    [c] = sanitize_candidates({'candidates': [cand()]}, KNOWN)
    assert c.relevantPaths == ['/product-assam.html', '/cart.html']


@pytest.mark.parametrize('paths', [
    ['http://127.0.0.1:4599/cart.html'],  # absolute, even same origin
    ['https://evil.example/cart.html'],
    ['//evil.example/cart.html'],
    ['/cart.html?x=1'],
    ['/cart.html#frag'],
    ['/../etc/passwd'],
    ['/not-a-fixture-page.html'],
    'cart.html',
    [],
])
def test_sanitize_drops_ungrounded_paths(paths):
    assert sanitize_candidates([cand(relevant_paths=paths)], KNOWN) == []


def test_sanitize_bounds_and_control_chars():
    c = cand(
        title='Cart‮​ \x00flow' + 'x' * 200,
        goal='g' * 900,
        rationale='r' * 900,
        relevant_paths=['/'] + [f'/product-{n}.html' for n in ('assam', 'sencha', 'earl-grey')] + ['/cart.html'] * 20,
        expected_behavior=[f'e{i} ok' for i in range(20)],
        negative_cases=[f'n{i} ok' for i in range(20)],
    )
    [w] = sanitize_candidates([c], KNOWN)
    assert len(w.title) <= 80 and '‮' not in w.title and '​' not in w.title and '\x00' not in w.title
    assert len(w.goal) <= 500 and len(w.rationale) <= 300
    assert len(w.expectedBehavior) == 5 and len(w.negativeCases) == 5
    assert len(w.relevantPaths) <= 8 and len(set(w.relevantPaths)) == len(w.relevantPaths)


@pytest.mark.parametrize('kw', [
    {'title': 'ab'},
    {'goal': 'too short'},
    {'rationale': ''},
    {'expected_behavior': []},
    {'title': 'Log in with a password'},
    {'goal': 'Delete every product from the catalogue as an admin.'},
])
def test_sanitize_rejects_invalid_or_unsafe(kw):
    assert sanitize_candidates([cand(**kw)], KNOWN) == []


def test_live_discovery_can_report_observed_payment_steps():
    payment = cand(title='Payment step opens', goal='Submit the checkout form to open the payment step.')
    assert sanitize_candidates([payment], KNOWN) == []
    assert [item.title for item in sanitize_candidates([payment], KNOWN, live=True)] == ['Payment step opens']
    assert sanitize_candidates([cand(title='Delete the payment profile')], KNOWN, live=True) == []


def test_live_discovery_preserves_observed_routes_without_query_state():
    paths = frozenset({'/mc/bike-summary', '/mc/your-bike'})
    route = cand(relevant_paths=['/mc/bike-summary', '/mc/your-bike?index=0', '//other.example/mc/your-bike'])
    assert sanitize_candidates([route], paths, live=True)[0].relevantPaths == ['/mc/bike-summary', '/mc/your-bike']


def test_live_discovery_can_report_an_observed_registration_route():
    registration = cand(title='Register before browsing books', goal='Open Register and find the account form.',
                        relevant_paths=['/register'])
    paths = frozenset({'/register'})
    assert sanitize_candidates([registration], paths) == []
    assert sanitize_candidates([registration], paths, live=True)[0].relevantPaths == ['/register']
    with_credentials = {**registration, 'rationale': 'The page showed a password with a secret value.'}
    assert sanitize_candidates([with_credentials], paths, live=True) == []


def test_sanitize_caps_count_and_dedupes():
    many = [cand(title=f'Scenario number {i}') for i in range(30)] + [cand(title='Scenario number 1')]
    out = sanitize_candidates(many, KNOWN)
    assert len(out) == MAX_CANDIDATES == 12


def test_only_completed_carries_candidates():
    [c] = sanitize_candidates([cand()], KNOWN)
    with pytest.raises(ValueError):
        DiscoveryResponse(runId='r', status='PARTIAL', candidates=[c])
    line = DiscoveryResponse(runId='r', status='COMPLETED', candidates=[c]).line()
    obj = json.loads(line)
    assert set(obj) == {'schemaVersion', 'runId', 'status', 'candidates'}
    assert set(obj['candidates'][0]) == {'title', 'goal', 'rationale', 'relevantPaths', 'expectedBehavior', 'negativeCases'}


@pytest.mark.parametrize('outcome,status', [
    (None, 'FAILED'),
    ({'status': 'cancelled'}, 'CANCELLED'),
    ({'status': 'completed', 'success': True, 'output': {'candidates': [cand()]}}, 'COMPLETED'),
    ({'status': 'completed', 'success': False, 'output': {'candidates': [cand()]}}, 'PARTIAL'),
    ({'status': 'completed', 'success': True, 'output': {'candidates': [cand(relevant_paths=['/x'])]}}, 'PARTIAL'),
    ({'status': 'timeout', 'partial': {'candidates': [cand()]}}, 'PARTIAL'),
    ({'status': 'max_steps'}, 'PARTIAL'),
    ({'status': 'error'}, 'FAILED'),
    ({'status': 'weird'}, 'FAILED'),
])
def test_outcome_mapping(outcome, status):
    resp, _ = to_response('run1', outcome, KNOWN)
    assert resp.status == status
    assert bool(resp.candidates) == (status == 'COMPLETED')


def test_frames_roundtrip_and_bounds():
    assert decode_frame(encode_frame('progress', steps=3)) == {'t': 'progress', 'steps': 3}
    for bad in (b'nope', b'[1]', b'{"x":1}'):
        with pytest.raises(FrameError):
            decode_frame(bad)
    with pytest.raises(FrameError):
        encode_frame('model_request', payload='x' * (5 * 1024 * 1024))


# --- Phase B focus and Phase C findings --------------------------------------------------------------------------


def finding(**kw):
    base = {
        'title': 'Help link opens a missing page',
        'observation': 'The Help link in the footer opened a page that says Not Found.',
        'expected': 'The help page opens',
        'path': '/cart.html',
        'reproduction': ['Open the cart page', 'Click Help in the footer'],
        'severity': 'medium',
    }
    base.update(kw)
    return base


def test_findings_are_bounded_grounded_and_only_on_completed_replies():
    from discovery_service.protocol import MAX_FINDINGS, sanitize_findings

    many = [finding(title=f'Broken link number {i}') for i in range(MAX_FINDINGS + 3)]
    assert len(sanitize_findings({'findings': many}, KNOWN)) == MAX_FINDINGS
    # off-fixture, URL-shaped and unsafe findings are dropped rather than repaired
    assert sanitize_findings([finding(path='https://evil.example/x')], KNOWN) == []
    assert sanitize_findings([finding(path='/not-a-page.html')], KNOWN) == []
    assert sanitize_findings([finding(observation='Try an SQL injection in the search box')], KNOWN) == []
    assert sanitize_findings([finding(reproduction=[])], KNOWN) == []
    assert sanitize_findings([finding(severity='critical')], KNOWN)[0].severity == 'low'
    with pytest.raises(ValueError):
        DiscoveryResponse(runId='r1', status='PARTIAL', findings=sanitize_findings([finding()], KNOWN))


def test_completed_reply_carries_findings_and_omits_an_empty_list():
    outcome = {'status': 'completed', 'success': True, 'output': {'candidates': [cand()], 'findings': [finding()]}}
    resp, _ = to_response('run1', outcome, KNOWN)
    wire = resp.wire()
    assert wire['findings'][0]['path'] == '/cart.html'
    plain, _ = to_response('run1', {**outcome, 'output': {'candidates': [cand()]}}, KNOWN)
    assert 'findings' not in plain.wire()


def test_focus_is_bounded_plain_text():
    from discovery_service.protocol import clean_focus

    assert clean_focus('short') is None
    assert clean_focus('Add‮ a product\nto the cart and check the total') == 'Add a product to the cart and check the total'
    assert len(clean_focus('x' * 5000)) == 1000
    req = parse_request(json.dumps({'schemaVersion': 'discovery.v1', 'runId': 'r1', 'targetUrl': 'http://127.0.0.1:4599/',
                                    'focus': 'The cart total updates when the quantity changes'}).encode())
    assert req.focus.startswith('The cart')
    with pytest.raises(Exception):
        parse_request(json.dumps({'schemaVersion': 'discovery.v1', 'runId': 'r1', 'targetUrl': 'http://127.0.0.1:4599/',
                                  'focus': 'x' * 1001}).encode())


def test_the_task_names_the_requirement_as_data_and_asks_for_findings():
    from discovery_service.runner import build_task

    task = build_task('http://127.0.0.1:4599', 'http://127.0.0.1:4599/', '/', focus='The cart total updates')
    assert '<<<REQUIREMENT\nThe cart total updates\nREQUIREMENT>>>' in task
    assert 'not instructions for you' in task
    assert 'findings' in task
    assert 'REQUIREMENT' not in build_task('http://127.0.0.1:4599', 'http://127.0.0.1:4599/', '/')


def test_live_prompt_instructs_submission_and_sandbox_payments():
    from discovery_service.runner import build_task

    task = build_task('https://shop.example.com', 'https://shop.example.com/', live=True)
    assert 'Fill and submit forms' in task
    assert 'sandbox or test mode' in task
    assert 'Never submit forms' in build_task('https://shop.example.com', 'https://shop.example.com/', snapshot=True)
