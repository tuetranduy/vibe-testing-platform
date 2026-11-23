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
