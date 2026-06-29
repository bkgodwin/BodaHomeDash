from __future__ import annotations

import json
from abc import ABC, abstractmethod
from typing import Any

import httpx


class BarcodeProvider(ABC):
    @abstractmethod
    async def lookup(self, barcode: str) -> dict[str, Any] | None:
        raise NotImplementedError


class OpenFoodFactsProvider(BarcodeProvider):
    endpoint = "https://world.openfoodfacts.org/api/v2/product/{barcode}.json"

    def __init__(self, client: httpx.AsyncClient):
        self.client = client

    async def lookup(self, barcode: str) -> dict[str, Any] | None:
        response = await self.client.get(
            self.endpoint.format(barcode=barcode),
            params={
                "fields": ",".join(
                    [
                        "code",
                        "product_name",
                        "brands",
                        "categories",
                        "quantity",
                        "image_front_small_url",
                        "nutriments",
                        "ingredients_text",
                        "allergens",
                    ]
                )
            },
            headers={
                "User-Agent": "HomeDashboard/0.1 (household kiosk; open-source)"
            },
            timeout=12,
        )
        response.raise_for_status()
        payload = response.json()
        if payload.get("status") != 1 or not payload.get("product"):
            return None
        product = payload["product"]
        name = (product.get("product_name") or "").strip()
        if not name:
            return None
        return {
            "barcode": barcode,
            "name": name,
            "brand": (product.get("brands") or "").split(",")[0].strip(),
            "category": (product.get("categories") or "").split(",")[0].strip(),
            "package_size": (product.get("quantity") or "").strip(),
            "image_url": product.get("image_front_small_url") or "",
            "nutrition": product.get("nutriments") or {},
            "ingredients": product.get("ingredients_text") or "",
            "allergens": product.get("allergens") or "",
            "source": "openfoodfacts",
            "raw_provider": product,
        }
