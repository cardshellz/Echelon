// Lists ShipStation V1 API stores with their integer storeId (the value
// you put into channels.shipping_config -> shipstation.storeId).
//
// Run via:
//   heroku run -a cardshellz-echelon -- "node scripts/list-shipstation-stores.mjs"

const key = process.env.SHIPSTATION_API_KEY;
const secret = process.env.SHIPSTATION_API_SECRET;
if (!key || !secret) {
  console.error("Missing SHIPSTATION_API_KEY or SHIPSTATION_API_SECRET");
  process.exit(1);
}

const auth = "Basic " + Buffer.from(`${key}:${secret}`).toString("base64");
const res = await fetch("https://ssapi.shipstation.com/stores", {
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
    data.map((s) => ({
      storeId: s.storeId,
      storeName: s.storeName,
      marketplaceName: s.marketplaceName,
      active: s.active,
    })),
    null,
    2,
  ),
);
