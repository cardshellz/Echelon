import { 
  type User, 
  type InsertUser, 
  type ProductLocation, 
  type InsertProductLocation,
  type UpdateProductLocation,
  users,
  productLocations
} from "@shared/schema";
import { db } from "./db";
import { eq } from "drizzle-orm";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  // Product Locations
  getAllProductLocations(): Promise<ProductLocation[]>;
  getProductLocationById(id: number): Promise<ProductLocation | undefined>;
  getProductLocationBySku(sku: string): Promise<ProductLocation | undefined>;
  createProductLocation(location: InsertProductLocation): Promise<ProductLocation>;
  updateProductLocation(id: number, location: UpdateProductLocation): Promise<ProductLocation | undefined>;
  deleteProductLocation(id: number): Promise<boolean>;
}

export class DatabaseStorage implements IStorage {
  // User methods
  async getUser(id: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id));
    return result[0];
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.username, username));
    return result[0];
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const result = await db.insert(users).values(insertUser).returning();
    return result[0];
  }

  // Product Location methods
  async getAllProductLocations(): Promise<ProductLocation[]> {
    return await db.select().from(productLocations).orderBy(productLocations.sku);
  }

  async getProductLocationById(id: number): Promise<ProductLocation | undefined> {
    const result = await db.select().from(productLocations).where(eq(productLocations.id, id));
    return result[0];
  }

  async getProductLocationBySku(sku: string): Promise<ProductLocation | undefined> {
    const result = await db.select().from(productLocations).where(eq(productLocations.sku, sku.toUpperCase()));
    return result[0];
  }

  async createProductLocation(location: InsertProductLocation): Promise<ProductLocation> {
    const result = await db.insert(productLocations).values({
      ...location,
      sku: location.sku.toUpperCase(),
      location: location.location.toUpperCase(),
      zone: location.zone.toUpperCase(),
    }).returning();
    return result[0];
  }

  async updateProductLocation(id: number, location: UpdateProductLocation): Promise<ProductLocation | undefined> {
    const updates: any = { ...location };
    if (updates.sku) updates.sku = updates.sku.toUpperCase();
    if (updates.location) updates.location = updates.location.toUpperCase();
    if (updates.zone) updates.zone = updates.zone.toUpperCase();
    updates.updatedAt = new Date();
    
    const result = await db
      .update(productLocations)
      .set(updates)
      .where(eq(productLocations.id, id))
      .returning();
    return result[0];
  }

  async deleteProductLocation(id: number): Promise<boolean> {
    const result = await db.delete(productLocations).where(eq(productLocations.id, id)).returning();
    return result.length > 0;
  }
}

export const storage = new DatabaseStorage();
