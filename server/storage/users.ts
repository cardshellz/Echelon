import { db, users, eq } from "./base";
import type { User, InsertUser, SafeUser } from "./base";

export interface IUserStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUserLastLogin(id: string): Promise<void>;
  updateUser(id: string, data: { displayName?: string; role?: string; password?: string; active?: number }): Promise<User | undefined>;
  getAllUsers(): Promise<SafeUser[]>;
}

export const userMethods: IUserStorage = {
  async getUser(id: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id));
    return result[0];
  },

  async getUserByUsername(username: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.username, username));
    return result[0];
  },

  async createUser(insertUser: InsertUser): Promise<User> {
    const result = await db.insert(users).values(insertUser).returning();
    return result[0];
  },

  async updateUserLastLogin(id: string): Promise<void> {
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, id));
  },

  async updateUser(id: string, data: { displayName?: string; role?: string; password?: string; active?: number }): Promise<User | undefined> {
    const updateData: Partial<{ displayName: string; role: string; password: string; active: number }> = {};
    if (data.displayName !== undefined) updateData.displayName = data.displayName;
    if (data.role !== undefined) updateData.role = data.role;
    if (data.password !== undefined) updateData.password = data.password;
    if (data.active !== undefined) updateData.active = data.active;
    
    if (Object.keys(updateData).length === 0) return undefined;
    
    const result = await db.update(users).set(updateData).where(eq(users.id, id)).returning();
    return result[0];
  },

  async getAllUsers(): Promise<SafeUser[]> {
    const result = await db.select({
      id: users.id,
      username: users.username,
      role: users.role,
      displayName: users.displayName,
      active: users.active,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
    }).from(users);
    return result as SafeUser[];
  },
};
