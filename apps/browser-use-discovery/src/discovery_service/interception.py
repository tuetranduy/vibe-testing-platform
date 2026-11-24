"""Per-job TLS interception material for live mode (egress_proxy.LiveProxy).

One fresh EC key per job. The launcher keeps nothing: it hands the private key to the job's egress proxy and the
key's SPKI pin to the job's Chromium (``--ignore-certificate-errors-spki-list``). Chromium then accepts leaf
certificates the proxy mints on that key, for that job only; no CA is installed anywhere and nothing else trusts it.
"""

from __future__ import annotations

import base64
import datetime as dt

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID


def new_job_key() -> tuple[bytes, str]:
    """(PKCS#8 PEM private key, base64 SHA-256 of its SubjectPublicKeyInfo)."""
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    return pem, spki_pin(key.public_key())


def spki_pin(public_key: ec.EllipticCurvePublicKey) -> str:
    der = public_key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    digest = hashes.Hash(hashes.SHA256())
    digest.update(der)
    return base64.b64encode(digest.finalize()).decode()


def leaf_certificate_pem(key_pem: bytes, host: str, now: dt.datetime | None = None) -> bytes:
    """A self-signed leaf for `host` on the job key, valid for a day around `now`."""
    key = serialization.load_pem_private_key(key_pem, password=None)
    if not isinstance(key, ec.EllipticCurvePrivateKey):
        raise ValueError('the job key must be an EC key')
    now = now or dt.datetime.now(dt.UTC)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, host)])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(hours=1))
        .not_valid_after(now + dt.timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(host)]), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(key, hashes.SHA256())
    )
    return cert.public_bytes(serialization.Encoding.PEM)
