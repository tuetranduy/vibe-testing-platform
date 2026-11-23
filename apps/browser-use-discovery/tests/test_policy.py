import pytest

from discovery_service.policy import PolicyError, match_target, normalize_url

CONFIGURED = 'http://127.0.0.1:4599/'


def test_exact_match():
    t = match_target(CONFIGURED, 'http://127.0.0.1:4599/')
    assert (t.host, t.port, t.path, t.needs_host_alias) == ('127.0.0.1', 4599, '/', False)


def test_hostname_fixture_gets_alias():
    t = match_target('http://fixture.staging.test:8080/', 'http://FIXTURE.staging.test:8080/')
    assert t.needs_host_alias and t.origin == 'http://fixture.staging.test:8080'


@pytest.mark.parametrize('requested', [
    'http://127.0.0.1:4598/',
    'http://localhost:4599/',  # different host string: exact match only
    'http://127.0.0.1:4599/cart.html',
    'https://127.0.0.1:4599/',
    'http://127.0.0.1:4599/?q=1',
    'http://127.0.0.1:4599/#x',
    'http://user:pw@127.0.0.1:4599/',
    'http://169.254.169.254/latest/meta-data/',
    'http://example.com/',
    'file:///etc/passwd',
    ' http://127.0.0.1:4599/',
    '',
])
def test_everything_else_is_blocked(requested):
    with pytest.raises(PolicyError):
        match_target(CONFIGURED, requested)


@pytest.mark.parametrize('configured', [
    '', 'https://127.0.0.1:4599/', 'http://10.0.0.5:4599/', 'http://[::1]:4599/', 'http://127.0.0.1:80/',
    'http://127.0.0.1:4599/../x', 'http://bad_host:4599/',
])
def test_bad_operator_config_is_rejected(configured):
    with pytest.raises(PolicyError):
        normalize_url(configured)
