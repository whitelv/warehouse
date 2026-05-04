from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from datetime import datetime
from bson import ObjectId
import os

from database import products_col, operations_col, workers_col
from models import Product, ProductUpdate, Operation, Worker, OutgoingOperation

app = FastAPI(title="Warehouse Inventory API")

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")
app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

@app.get("/")
async def root():
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))

@app.get("/style.css")
async def style():
    return FileResponse(os.path.join(FRONTEND_DIR, "style.css"), media_type="text/css")

@app.get("/script.js")
async def script():
    return FileResponse(os.path.join(FRONTEND_DIR, "script.js"), media_type="application/javascript")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ════════════════════════════════════════════════════════
#  Адмін (захардкоджений)
# ════════════════════════════════════════════════════════
ADMIN_RFID = "A7012249"
ADMIN_WORKER = {"rfid": ADMIN_RFID, "name": "Федчишин Станіслав", "role": "admin"}

# ════════════════════════════════════════════════════════
#  Сесія
# ════════════════════════════════════════════════════════
current_session = {"rfid": None, "name": None, "role": None}

def require_auth():
    if not current_session.get("rfid"):
        raise HTTPException(status_code=401, detail="Authorization required")
    return current_session

def require_admin():
    require_auth()
    if current_session.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return current_session

@app.get("/session/")
async def get_session():
    return current_session

@app.post("/session/logout/")
async def logout():
    current_session["rfid"] = None
    current_session["name"] = None
    current_session["role"] = None
    return {"message": "Logged out"}

# ════════════════════════════════════════════════════════
#  Утиліта
# ════════════════════════════════════════════════════════
def fix_id(doc):
    if doc and "_id" in doc:
        doc["_id"] = str(doc["_id"])
    return doc

# ════════════════════════════════════════════════════════
#  ТОВАРИ
# ════════════════════════════════════════════════════════
@app.get("/products/")
async def get_all_products():
    require_auth()
    cursor = products_col.find()
    result = []
    async for doc in cursor:
        result.append(fix_id(doc))
    return result

@app.get("/products/barcode/{barcode}")
async def get_product_by_barcode(barcode: str):
    require_auth()
    doc = await products_col.find_one({"barcode": barcode})
    if not doc:
        raise HTTPException(status_code=404, detail="Product not found")
    return fix_id(doc)

@app.post("/products/")
async def create_product(product: Product):
    require_admin()
    existing = await products_col.find_one({"barcode": product.barcode})
    if existing:
        raise HTTPException(status_code=400, detail="Product with this barcode already exists")
    await products_col.insert_one(product.dict())
    return {"message": "Product created", "barcode": product.barcode}

@app.patch("/products/{barcode}")
async def update_product(barcode: str, data: ProductUpdate):
    require_auth()
    update = {k: v for k, v in data.dict().items() if v is not None}
    if not update:
        raise HTTPException(status_code=400, detail="No fields to update")
    result = await products_col.update_one({"barcode": barcode}, {"$set": update})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Product not found")
    return {"message": "Updated"}

@app.delete("/products/{barcode}")
async def delete_product(barcode: str):
    require_admin()
    result = await products_col.delete_one({"barcode": barcode})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Product not found")
    return {"message": "Deleted"}

# ════════════════════════════════════════════════════════
#  ОПЕРАЦІЇ
# ════════════════════════════════════════════════════════
@app.get("/operations/")
async def get_operations(limit: int = 50):
    require_auth()
    cursor = operations_col.find().sort("timestamp", -1).limit(limit)
    result = []
    async for doc in cursor:
        result.append(fix_id(doc))
    return result

@app.delete("/operations/")
async def clear_operations():
    require_admin()
    await operations_col.delete_many({})
    return {"message": "History cleared"}

@app.post("/operations/")
async def create_incoming_operation(op: Operation):
    require_auth()
    product = await products_col.find_one({"barcode": op.barcode})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    op.timestamp = datetime.utcnow()
    op.type = "incoming"
    await operations_col.insert_one(op.dict())
    new_stock = product["current_stock"] + op.quantity
    await products_col.update_one({"barcode": op.barcode}, {"$set": {"current_stock": new_stock}})
    warning = None
    if new_stock < product["min_stock"]:
        warning = f"Low stock! Only {new_stock} pcs remaining (min: {product['min_stock']})"
    return {"message": "Operation saved", "new_stock": new_stock, "warning": warning}

@app.post("/operations/outgoing/")
async def create_outgoing_operation(op: OutgoingOperation):
    require_auth()
    product = await products_col.find_one({"barcode": op.barcode})
    if not product:
        raise HTTPException(status_code=404, detail="Product not found")
    if product["current_stock"] < op.quantity:
        raise HTTPException(status_code=400, detail="Not enough stock")
    operation = {
        "barcode": op.barcode, "quantity": op.quantity,
        "gross_weight": 0, "tare_weight": 0,
        "worker_rfid": op.worker_rfid, "type": "outgoing",
        "timestamp": datetime.utcnow()
    }
    await operations_col.insert_one(operation)
    new_stock = product["current_stock"] - op.quantity
    await products_col.update_one({"barcode": op.barcode}, {"$set": {"current_stock": new_stock}})
    warning = None
    if new_stock < product["min_stock"]:
        warning = f"Low stock! Only {new_stock} pcs remaining (min: {product['min_stock']})"
    return {"message": "Outgoing operation saved", "new_stock": new_stock, "warning": warning}

# ════════════════════════════════════════════════════════
#  ПРАЦІВНИКИ
# ════════════════════════════════════════════════════════
@app.get("/workers/")
async def get_workers():
    require_auth()
    result = [ADMIN_WORKER.copy()]
    cursor = workers_col.find()
    async for doc in cursor:
        result.append(fix_id(doc))
    return result

@app.get("/workers/{rfid}/")
async def get_worker_by_rfid(rfid: str):
    rfid_upper = rfid.upper()
    # Адмін
    if rfid_upper == ADMIN_RFID:
        current_session["rfid"] = ADMIN_RFID
        current_session["name"] = ADMIN_WORKER["name"]
        current_session["role"] = "admin"
        return ADMIN_WORKER
    # Комірник
    doc = await workers_col.find_one({"rfid": rfid_upper})
    if not doc:
        raise HTTPException(status_code=404, detail="Worker not found")
    current_session["rfid"] = doc["rfid"]
    current_session["name"] = doc["name"]
    current_session["role"] = doc.get("role", "storekeeper")
    return fix_id(doc)

@app.post("/workers/")
async def create_worker(worker: Worker):
    require_admin()
    if worker.rfid.upper() == ADMIN_RFID:
        raise HTTPException(status_code=400, detail="This RFID is reserved for admin")
    existing = await workers_col.find_one({"rfid": worker.rfid.upper()})
    if existing:
        raise HTTPException(status_code=400, detail="Worker with this RFID already exists")
    data = worker.dict()
    data["rfid"] = data["rfid"].upper()
    data["role"] = "storekeeper"
    await workers_col.insert_one(data)
    return {"message": "Worker created"}

@app.delete("/workers/{rfid}")
async def delete_worker(rfid: str):
    require_admin()
    if rfid.upper() == ADMIN_RFID:
        raise HTTPException(status_code=400, detail="Cannot delete admin")
    result = await workers_col.delete_one({"rfid": rfid})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Worker not found")
    return {"message": "Deleted"}

# ════════════════════════════════════════════════════════
#  RFID / OLED / WEIGHT
# ════════════════════════════════════════════════════════
last_scanned_rfid = {"rfid": None}
register_mode = {"active": False}
login_mode = {"active": False}
oled_message = {"line1": "", "line2": "", "line3": "", "updated": False}
current_weight_value = {"weight": None}
confirmed_weight_value = {"weight": None}
weigh_mode = {"active": False}
weigh_pending = {"barcode": None}

@app.post("/oled/")
async def set_oled(data: dict):
    oled_message["line1"] = data.get("line1", "")
    oled_message["line2"] = data.get("line2", "")
    oled_message["line3"] = data.get("line3", "")
    oled_message["updated"] = True
    return {"ok": True}

@app.get("/oled/")
async def get_oled():
    if oled_message["updated"]:
        oled_message["updated"] = False
        return {"updated": True, "line1": oled_message["line1"], "line2": oled_message["line2"], "line3": oled_message["line3"]}
    return {"updated": False, "line1": "", "line2": "", "line3": ""}

@app.post("/weight/mode/")
async def set_weigh_mode(data: dict):
    weigh_mode["active"] = data.get("active", False)
    return {"active": weigh_mode["active"]}

@app.get("/weight/mode/")
async def get_weigh_mode():
    return {"active": weigh_mode["active"]}

@app.post("/weight/current/")
async def set_current_weight(data: dict):
    current_weight_value["weight"] = data.get("weight")
    return {"ok": True, "active": weigh_mode["active"]}

@app.get("/weight/current/")
async def get_current_weight():
    return {"weight": current_weight_value["weight"]}

@app.post("/weight/confirmed/")
async def set_confirmed_weight(data: dict):
    confirmed_weight_value["weight"] = data.get("weight")
    return {"ok": True}

@app.get("/weight/confirmed/")
async def get_confirmed_weight():
    w = confirmed_weight_value["weight"]
    confirmed_weight_value["weight"] = None
    return {"weight": w}

@app.get("/rfid/login-mode/")
async def get_login_mode():
    return {"active": login_mode["active"]}

@app.post("/rfid/login-mode/")
async def set_login_mode(data: dict):
    login_mode["active"] = data.get("active", False)
    return {"active": login_mode["active"]}

@app.get("/rfid/register-mode/")
async def get_register_mode():
    return {"active": register_mode["active"]}

@app.post("/rfid/register-mode/")
async def set_register_mode(data: dict):
    register_mode["active"] = data.get("active", False)
    if not register_mode["active"]:
        last_scanned_rfid["rfid"] = None
    return {"active": register_mode["active"]}

@app.post("/rfid/scanned/")
async def rfid_scanned(data: dict):
    rfid = data.get("rfid", "").upper()
    if not rfid:
        raise HTTPException(status_code=400, detail="No RFID provided")
    if register_mode["active"]:
        last_scanned_rfid["rfid"] = rfid
        return {"message": "RFID received", "rfid": rfid, "mode": "register"}
    return {"message": "RFID received", "rfid": rfid, "mode": "login"}

@app.get("/rfid/last/")
async def get_last_rfid():
    rfid = last_scanned_rfid["rfid"]
    last_scanned_rfid["rfid"] = None
    return {"rfid": rfid}

@app.post("/weigh/start/")
async def weigh_start(data: dict):
    weigh_pending["barcode"] = data.get("barcode")
    return {"ok": True}

@app.get("/weigh/pending/")
async def weigh_pending_get():
    return {"barcode": weigh_pending["barcode"]}

@app.post("/weigh/confirm/")
async def weigh_confirm():
    weigh_pending["barcode"] = None
    return {"ok": True}

# ════════════════════════════════════════════════════════
#  СТАТИСТИКА
# ════════════════════════════════════════════════════════
@app.get("/stats/")
async def get_stats():
    require_auth()
    total_products = await products_col.count_documents({})
    total_operations = await operations_col.count_documents({})
    low_stock_cursor = products_col.find({"$expr": {"$lt": ["$current_stock", "$min_stock"]}})
    low_stock = []
    async for doc in low_stock_cursor:
        low_stock.append(fix_id(doc))
    return {
        "total_products": total_products,
        "total_operations": total_operations,
        "low_stock_count": len(low_stock),
        "low_stock_items": low_stock
    }

@app.get("/debug/mongo")
async def debug_mongo():
    from database import MONGO_URL
    return {"mongo_url": MONGO_URL[:30] + "..."}

import asyncio
import httpx

async def keep_alive():
    await asyncio.sleep(60)
    while True:
        try:
            async with httpx.AsyncClient() as client:
                await client.get("https://warehouse-x4uc.onrender.com/health")
        except:
            pass
        await asyncio.sleep(840)

@app.get("/health")
async def health():
    return {"status": "ok"}

@app.on_event("startup")
async def startup():
    asyncio.create_task(keep_alive())
