from __future__ import annotations

import re
from typing import Any


def _steps(value: str) -> list[str]:
    lines = [
        re.sub(r"^\s*(?:step\s*)?\d+[.)\-:]\s*", "", line, flags=re.I).strip()
        for line in re.split(r"[\r\n]+", value or "")
        if line.strip()
    ]
    if len(lines) <= 1 and value.strip():
        lines = [
            sentence.strip()
            for sentence in re.split(r"(?<=[.!?])\s+(?=[A-Z])", value.strip())
            if sentence.strip()
        ]
    return lines


def normalize_meal(meal: dict[str, Any]) -> dict[str, Any]:
    ingredients = []
    for index in range(1, 21):
        name = str(meal.get(f"strIngredient{index}") or "").strip()
        measure = str(meal.get(f"strMeasure{index}") or "").strip()
        if name:
            ingredients.append({"name": name, "measure": measure})
    return {
        "recipe_id": f"mealdb:{meal.get('idMeal')}",
        "source": "themealdb",
        "title": str(meal.get("strMeal") or "Untitled recipe").strip(),
        "category": str(meal.get("strCategory") or "").strip(),
        "area": str(meal.get("strArea") or "").strip(),
        "image_url": str(meal.get("strMealThumb") or "").strip(),
        "image_data": "",
        "ingredients": ingredients,
        "steps": _steps(str(meal.get("strInstructions") or "")),
        "favorite": False,
        "custom": False,
    }
