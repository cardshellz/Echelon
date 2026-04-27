import type { ProductLocation, InsertProductLocation, UpdateProductLocation } from "@shared/schema";

const API_BASE = "/api";

// Product Locations API
export const locationsApi = {
  getAll: async (): Promise<ProductLocation[]> => {
    const response = await fetch(`${API_BASE}/locations`);
    if (!response.ok) throw new Error("Failed to fetch locations");
    return response.json();
  },

  getById: async (id: number): Promise<ProductLocation> => {
    const response = await fetch(`${API_BASE}/locations/${id}`);
    if (!response.ok) throw new Error("Failed to fetch location");
    return response.json();
  },

  getBySku: async (sku: string): Promise<ProductLocation> => {
    const response = await fetch(`${API_BASE}/locations/sku/${sku}`);
    if (!response.ok) throw new Error("Failed to fetch location");
    return response.json();
  },

  create: async (location: InsertProductLocation): Promise<ProductLocation> => {
    const response = await fetch(`${API_BASE}/locations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(location),
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Failed to create location");
    }
    return response.json();
  },

  update: async (id: number, location: UpdateProductLocation): Promise<ProductLocation> => {
    const response = await fetch(`${API_BASE}/locations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(location),
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "Failed to update location");
    }
    return response.json();
  },

  delete: async (id: number): Promise<void> => {
    const response = await fetch(`${API_BASE}/locations/${id}`, {
      method: "DELETE",
    });
    if (!response.ok) throw new Error("Failed to delete location");
  },
};

// Order hold/release API
export async function holdOrder(orderId: number): Promise<void> {
  const response = await fetch(`${API_BASE}/orders/${orderId}/hold`, {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Failed to hold order" }));
    throw new Error(error.error || "Failed to hold order");
  }
}

export async function releaseHoldOrder(orderId: number): Promise<void> {
  const response = await fetch(`${API_BASE}/orders/${orderId}/release-hold`, {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Failed to release hold" }));
    throw new Error(error.error || "Failed to release hold");
  }
}

export async function setOrderPriority(orderId: number, priority: "rush" | "high" | "normal"): Promise<void> {
  const response = await fetch(`${API_BASE}/orders/${orderId}/priority`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ priority }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Failed to set priority" }));
    throw new Error(error.error || "Failed to set priority");
  }
}
