import { db } from "./db";
import { productLocations } from "@shared/schema";

const sampleLocations = [
  { sku: "NK-292-BLK", name: "Nike Air Max 90 Black", location: "A-01-02-B", zone: "A" },
  { sku: "NK-292-RED", name: "Nike Air Max 90 Red", location: "A-01-02-A", zone: "A" },
  { sku: "NK-AIR-RED", name: "Nike Air Force 1 Red", location: "A-02-01-A", zone: "A" },
  { sku: "AD-550-WHT", name: "Adidas Ultraboost White", location: "A-01-04-A", zone: "A" },
  { sku: "AD-STN-BLK", name: "Adidas Stan Smith Black", location: "A-02-03-B", zone: "A" },
  { sku: "NB-990-NVY", name: "New Balance 990v5 Navy", location: "B-12-01-C", zone: "B" },
  { sku: "PM-102-GRY", name: "Puma RS-X Grey", location: "B-12-04-D", zone: "B" },
  { sku: "VN-OLD-BLK", name: "Vans Old Skool Black", location: "B-05-02-A", zone: "B" },
  { sku: "CV-CHK-WHT", name: "Converse Chuck Taylor White", location: "B-05-04-C", zone: "B" },
  { sku: "RB-CL-TAN", name: "Reebok Classic Tan", location: "C-01-01-A", zone: "C" },
  { sku: "SK-BLZ-BLU", name: "Skechers Blazer Blue", location: "C-03-02-B", zone: "C" },
];

async function seed() {
  console.log("Seeding product locations...");
  
  try {
    for (const loc of sampleLocations) {
      await db.insert(productLocations).values(loc).onConflictDoNothing();
    }
    console.log("✓ Seeded", sampleLocations.length, "product locations");
  } catch (error) {
    console.error("Error seeding database:", error);
    process.exit(1);
  }
  
  process.exit(0);
}

seed();
