from __future__ import annotations

import re
import unicodedata


def normalize_name(value: str) -> str:
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    value = re.sub(r"[^a-zA-Z0-9]+", " ", value.lower())
    return " ".join(value.split())


def normalize_barcode(value: str) -> str:
    digits = "".join(character for character in value if character.isdigit())
    if len(digits) not in (8, 12, 13, 14):
        raise ValueError("Barcode must be an EAN-8, UPC-A, EAN-13, or GTIN-14")
    if not valid_gtin(digits):
        raise ValueError("Barcode check digit is invalid")
    return digits


def valid_gtin(digits: str) -> bool:
    if not digits.isdigit() or len(digits) not in (8, 12, 13, 14):
        return False
    body = digits[:-1]
    total = sum(
        int(number) * (3 if index % 2 == 0 else 1)
        for index, number in enumerate(reversed(body))
    )
    check = (10 - total % 10) % 10
    return check == int(digits[-1])
