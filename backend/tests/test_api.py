from datetime import date, timedelta


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
