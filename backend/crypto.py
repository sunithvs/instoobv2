import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from config import TOKEN_ENC_KEY


def _key() -> bytes:
    if not TOKEN_ENC_KEY:
        raise RuntimeError("TOKEN_ENC_KEY not set")
    key = base64.urlsafe_b64decode(TOKEN_ENC_KEY)
    if len(key) != 32:
        raise RuntimeError("TOKEN_ENC_KEY must decode to 32 bytes (AES-256)")
    return key


def encrypt(plaintext: str) -> bytes:
    aes = AESGCM(_key())
    nonce = os.urandom(12)
    ct = aes.encrypt(nonce, plaintext.encode("utf-8"), None)
    return nonce + ct


def decrypt(blob: bytes) -> str:
    aes = AESGCM(_key())
    nonce, ct = blob[:12], blob[12:]
    return aes.decrypt(nonce, ct, None).decode("utf-8")
