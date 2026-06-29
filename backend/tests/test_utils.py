from home_dashboard.utils import normalize_barcode, normalize_name, valid_gtin


def test_name_normalization():
    assert normalize_name("  Café au-Lait! ") == "cafe au lait"


def test_valid_upc():
    assert valid_gtin("036000291452")
    assert normalize_barcode("0 36000-29145 2") == "036000291452"


def test_invalid_upc():
    assert not valid_gtin("036000291453")
