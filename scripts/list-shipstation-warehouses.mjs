// Lists ShipStation V1 API warehouses with their integer warehouseId
// (the value you put into warehouses.shipping_config -> shipstation.warehouseId).
//
// Run via:
//   heroku run -a cardshellz-echelon -- "node scripts/list-shipstation-warehouses.mjs"

const key = process.env.SHIPSTATION_API_KEY;
const secret = process.env.SHIPSTATION_API_SECRET;
if (!key || !secret) {
  console.error("Missing SHIPSTATION_API_KEY or SHIPSTATION_API_SECRET");
  process.exit(1);
}

const auth = "Basic " + Buffer.from(`${key}:${secret}`).toString("base64");
const res = await fetch("https://ssapi.shipstation.com/warehouses", {
  headers: { Authorization: auth },
});
if (!res.ok) {
  console.error(`HTTP ${res.status}`);
  console.error(await res.text());
  process.exit(2);
}
const data = await res.json();
console.log(
  JSON.stringify(
    data.map((w) => ({
      warehouseId: w.warehouseId,
      warehouseName: w.warehouseName,
      isDefault: w.isDefault,
    })),
    null,
    2,
  ),
);
