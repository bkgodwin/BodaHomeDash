from datetime import date, timedelta

from home_dashboard import main as dashboard_main
from home_dashboard.main import _sanitize_nhc_html
from home_dashboard.providers.recipes import normalize_meal


def test_status_and_settings(client):
    response = client.get("/api/v1/status")
    assert response.status_code == 200
    assert response.json()["local"] is True
    assert response.json()["garbage_pickup_enabled"] is False
    assert response.json()["onscreen_keyboard_enabled"] is True
    response = client.patch(
        "/api/v1/settings",
        json={"values": {"household_name": "Bayou Home"}},
    )
    assert response.status_code == 200
    assert response.json()["household_name"] == "Bayou Home"


def test_nhc_html_sanitizer_keeps_navigation_without_scripts():
    cleaned = _sanitize_nhc_html(
        '<script>alert(1)</script><a href="/storm.php" onclick="bad()">Storm</a>'
    )
    assert "<script" not in cleaned
    assert "onclick" not in cleaned
    assert 'href="/api/v1/tropical/storm.php"' in cleaned


def test_mealdb_recipe_normalization():
    recipe = normalize_meal(
        {
            "idMeal": "42",
            "strMeal": "Bayou Supper",
            "strIngredient1": "Rice",
            "strMeasure1": "2 cups",
            "strInstructions": "Rinse rice.\r\nCook until tender.",
        }
    )
    assert recipe["recipe_id"] == "mealdb:42"
    assert recipe["ingredients"] == [{"name": "Rice", "measure": "2 cups"}]
    assert recipe["steps"] == ["Rinse rice.", "Cook until tender."]


def test_custom_recipe_crud_and_favorite(client, monkeypatch):
    created = client.post(
        "/api/v1/recipes/custom",
        json={
            "title": "Test Gumbo",
            "category": "Dinner",
            "area": "Louisiana",
            "ingredients": [{"name": "Okra", "measure": "2 cups"}],
            "steps": ["Slice the okra.", "Cook the gumbo."],
            "image_data": "",
        },
    )
    assert created.status_code == 200
    recipe = created.json()
    assert recipe["custom"] is True
    detail = client.get(f"/api/v1/recipes/{recipe['recipe_id']}")
    assert detail.status_code == 200
    favorite = client.put(
        f"/api/v1/recipes/{recipe['recipe_id']}/favorite?favorite=true"
    )
    assert favorite.json()["favorite"] is True
    search = client.get("/api/v1/recipes/search").json()
    assert search["recipes"][0]["title"] == "Test Gumbo"
    updated = client.put(
        f"/api/v1/recipes/custom/{recipe['recipe_id']}",
        json={
            "title": "Test Seafood Gumbo",
            "category": "Dinner",
            "area": "Louisiana",
            "ingredients": [
                {"name": "Shrimp", "measure": "1 lb"},
                {"name": "Garlic", "measure": "2 cloves"},
            ],
            "steps": ["Cook until done."],
            "image_data": "",
        },
    )
    assert updated.json()["favorite"] is True
    assert updated.json()["ingredients"][0]["name"] == "Shrimp"

    async def no_online_results(_: list[str]):
        return []

    monkeypatch.setattr(
        dashboard_main, "_mealdb_ingredient_recipes", no_online_results
    )
    ingredient_search = client.get(
        "/api/v1/recipes/search",
        params={"query": "shrimp, garlic", "mode": "ingredient"},
    )
    assert ingredient_search.status_code == 200
    assert ingredient_search.json()["recipes"][0]["title"] == "Test Seafood Gumbo"
    deleted = client.delete(f"/api/v1/recipes/custom/{recipe['recipe_id']}")
    assert deleted.status_code == 204


def test_garbage_pickup_preferences_are_exposed(client):
    response = client.patch(
        "/api/v1/settings",
        json={
            "values": {
                "garbage_pickup_enabled": True,
                "garbage_pickup_weekday": 4,
            }
        },
    )
    assert response.status_code == 200
    status = client.get("/api/v1/status").json()
    assert status["garbage_pickup_enabled"] is True
    assert status["garbage_pickup_weekday"] == 4


def test_shopping_pantry_match_and_batches(client):
    shopping = client.post(
        "/api/v1/shopping", json={"name": "Whole Milk", "quantity": 1}
    )
    assert shopping.status_code == 200
    pantry = client.post(
        "/api/v1/pantry",
        json={
            "name": "Whole Milk",
            "brand": "Test Dairy",
            "quantity": 2,
            "expires_on": (date.today() + timedelta(days=5)).isoformat(),
        },
    )
    assert pantry.status_code == 200
    assert pantry.json()["lots"][0]["quantity"] == 2
    shopping_items = client.get("/api/v1/shopping").json()
    assert shopping_items[0]["purchased"] == 1
    products = client.get("/api/v1/pantry").json()
    assert products[0]["total_quantity"] == 2


def test_reminders_and_timers(client):
    reminder = client.post("/api/v1/reminders", json={"text": "Feed the cat"})
    assert reminder.status_code == 200
    reminder_id = reminder.json()["id"]
    complete = client.patch(
        f"/api/v1/reminders/{reminder_id}", json={"completed": True}
    )
    assert complete.json()["completed"] == 1
    timer = client.post(
        "/api/v1/timers", json={"seconds": 300, "label": "Tea"}
    )
    assert timer.status_code == 200
    assert timer.json()["status"] == "running"


def test_reminder_priority_reordering_and_completed_sort_setting(client):
    first = client.post("/api/v1/reminders", json={"text": "First task"}).json()
    second = client.post("/api/v1/reminders", json={"text": "Second task"}).json()
    priority = client.patch(
        f"/api/v1/reminders/{second['id']}", json={"high_priority": True}
    )
    assert priority.json()["high_priority"] == 1
    all_items = client.get("/api/v1/reminders").json()
    reversed_ids = [item["id"] for item in reversed(all_items)]
    reordered = client.post(
        "/api/v1/reminders/reorder", json={"item_ids": reversed_ids}
    )
    assert reordered.status_code == 200
    client.patch(
        "/api/v1/settings",
        json={"values": {"completed_reminders_last": False}},
    )
    assert [item["id"] for item in client.get("/api/v1/reminders").json()] == reversed_ids
    client.patch(
        "/api/v1/settings",
        json={"values": {"completed_reminders_last": True}},
    )


def test_calendar_holidays_and_expirations(client):
    start = date(date.today().year, 1, 1)
    end = start + timedelta(days=99)
    response = client.get(f"/api/v1/calendar?start={start}&end={end}")
    assert response.status_code == 200
    assert {"events", "holidays", "expirations"} <= response.json().keys()


def test_sync_diagnostics_endpoint(client):
    response = client.get("/api/v1/sync/status")
    assert response.status_code == 200
    assert {"providers", "log"} <= response.json().keys()


def test_fifo_consume_batch_notes_and_selected_batch_delete(client):
    first = client.post(
        "/api/v1/pantry",
        json={
            "name": "FIFO Test Beans",
            "quantity": 2,
            "expires_on": "2027-01-01",
        },
    ).json()
    product_id = first["id"]
    first_lot = first["lots"][0]["id"]
    second = client.post(
        "/api/v1/pantry",
        json={
            "name": "FIFO Test Beans",
            "product_id": product_id,
            "quantity": 3,
            "expires_on": "2027-02-01",
        },
    ).json()
    second_lot = [lot for lot in second["lots"] if lot["id"] != first_lot][0]["id"]

    updated = client.patch(
        f"/api/v1/pantry/lots/{second_lot}",
        json={"notes": "Use for chili"},
    ).json()
    assert next(lot for lot in updated["lots"] if lot["id"] == second_lot)["notes"] == "Use for chili"

    consumed = client.post(f"/api/v1/pantry/{product_id}/consume").json()
    assert consumed["quantity"] == 4
    detail = client.get(f"/api/v1/products/{product_id}").json()
    assert next(lot for lot in detail["lots"] if lot["id"] == first_lot)["quantity"] == 1

    deleted = client.post(
        "/api/v1/pantry/lots/delete",
        json={"lot_ids": [second_lot], "add_to_shopping": False},
    )
    assert deleted.status_code == 204
    remaining = client.get(f"/api/v1/products/{product_id}").json()["lots"]
    assert [lot["id"] for lot in remaining] == [first_lot]


def test_display_awake_lock(client):
    enabled = client.put("/api/v1/display/awake-lock?enabled=true")
    assert enabled.status_code == 200
    assert enabled.json()["enabled"] is True
    assert client.get("/api/v1/status").json()["display_awake_lock"] is True
    disabled = client.put("/api/v1/display/awake-lock?enabled=false")
    assert disabled.json()["enabled"] is False
