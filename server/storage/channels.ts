import {
  db,
  type Channel,
  type InsertChannel,
  type ChannelConnection,
  type InsertChannelConnection,
  type PartnerProfile,
  type InsertPartnerProfile,
  type ChannelReservation,
  type InsertChannelReservation,
  type ProductVariant,
  channels,
  channelConnections,
  partnerProfiles,
  channelReservations,
  productVariants,
  eq, and, asc,
} from "./base";

export interface IChannelStorage {
  getAllChannels(): Promise<Channel[]>;
  getChannelById(id: number): Promise<Channel | undefined>;
  createChannel(channel: InsertChannel): Promise<Channel>;
  updateChannel(id: number, updates: Partial<InsertChannel>): Promise<Channel | null>;
  deleteChannel(id: number): Promise<boolean>;
  getChannelConnection(channelId: number): Promise<ChannelConnection | undefined>;
  upsertChannelConnection(connection: InsertChannelConnection): Promise<ChannelConnection>;
  updateChannelConnectionSyncStatus(channelId: number, status: string, error?: string | null): Promise<void>;
  getPartnerProfile(channelId: number): Promise<PartnerProfile | undefined>;
  upsertPartnerProfile(profile: InsertPartnerProfile): Promise<PartnerProfile>;
  getChannelReservations(channelId?: number): Promise<(ChannelReservation & { channel?: Channel; productVariant?: ProductVariant })[]>;
  getChannelReservationByChannelAndProductVariant(channelId: number, productVariantId: number): Promise<ChannelReservation | undefined>;
  upsertChannelReservation(reservation: InsertChannelReservation): Promise<ChannelReservation>;
  deleteChannelReservation(id: number): Promise<boolean>;
}

export const channelMethods: IChannelStorage = {
  async getAllChannels(): Promise<Channel[]> {
    return db.select().from(channels).orderBy(asc(channels.priority), asc(channels.name));
  },

  async getChannelById(id: number): Promise<Channel | undefined> {
    const result = await db.select().from(channels).where(eq(channels.id, id));
    return result[0];
  },

  async createChannel(channel: InsertChannel): Promise<Channel> {
    const result = await db.insert(channels).values(channel).returning();
    return result[0];
  },

  async updateChannel(id: number, updates: Partial<InsertChannel>): Promise<Channel | null> {
    const result = await db.update(channels)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(channels.id, id))
      .returning();
    return result[0] || null;
  },

  async deleteChannel(id: number): Promise<boolean> {
    const result = await db.delete(channels).where(eq(channels.id, id)).returning();
    return result.length > 0;
  },

  async getChannelConnection(channelId: number): Promise<ChannelConnection | undefined> {
    const result = await db.select().from(channelConnections).where(eq(channelConnections.channelId, channelId));
    return result[0];
  },

  async upsertChannelConnection(connection: InsertChannelConnection): Promise<ChannelConnection> {
    const existing = await this.getChannelConnection(connection.channelId);
    if (existing) {
      const result = await db.update(channelConnections)
        .set({ ...connection, updatedAt: new Date() })
        .where(eq(channelConnections.channelId, connection.channelId))
        .returning();
      return result[0];
    }
    const result = await db.insert(channelConnections).values(connection).returning();
    return result[0];
  },

  async updateChannelConnectionSyncStatus(channelId: number, status: string, error?: string | null): Promise<void> {
    await db.update(channelConnections)
      .set({
        syncStatus: status,
        syncError: error,
        lastSyncAt: status === 'ok' ? new Date() : undefined,
        updatedAt: new Date()
      })
      .where(eq(channelConnections.channelId, channelId));
  },

  async getPartnerProfile(channelId: number): Promise<PartnerProfile | undefined> {
    const result = await db.select().from(partnerProfiles).where(eq(partnerProfiles.channelId, channelId));
    return result[0];
  },

  async upsertPartnerProfile(profile: InsertPartnerProfile): Promise<PartnerProfile> {
    const existing = await this.getPartnerProfile(profile.channelId);
    if (existing) {
      const result = await db.update(partnerProfiles)
        .set({ ...profile, updatedAt: new Date() })
        .where(eq(partnerProfiles.channelId, profile.channelId))
        .returning();
      return result[0];
    }
    const result = await db.insert(partnerProfiles).values(profile).returning();
    return result[0];
  },

  async getChannelReservations(channelId?: number): Promise<(ChannelReservation & { channel?: Channel; productVariant?: ProductVariant })[]> {
    let query = db.select({
      reservation: channelReservations,
      channel: channels,
      productVariant: productVariants
    })
    .from(channelReservations)
    .leftJoin(channels, eq(channelReservations.channelId, channels.id))
    .leftJoin(productVariants, eq(channelReservations.productVariantId, productVariants.id));

    if (channelId) {
      query = query.where(eq(channelReservations.channelId, channelId)) as any;
    }

    const results = await query.orderBy(asc(channels.name));
    return results.map(r => ({
      ...r.reservation,
      channel: r.channel || undefined,
      productVariant: r.productVariant || undefined
    }));
  },

  async getChannelReservationByChannelAndProductVariant(channelId: number, productVariantId: number): Promise<ChannelReservation | undefined> {
    const result = await db.select().from(channelReservations)
      .where(and(
        eq(channelReservations.channelId, channelId),
        eq(channelReservations.productVariantId, productVariantId)
      ));
    return result[0];
  },

  async upsertChannelReservation(reservation: InsertChannelReservation): Promise<ChannelReservation> {
    const existing = await this.getChannelReservationByChannelAndProductVariant(reservation.channelId, reservation.productVariantId!);
    if (existing) {
      const result = await db.update(channelReservations)
        .set({ ...reservation, updatedAt: new Date() })
        .where(eq(channelReservations.id, existing.id))
        .returning();
      return result[0];
    }
    const result = await db.insert(channelReservations).values(reservation).returning();
    return result[0];
  },

  async deleteChannelReservation(id: number): Promise<boolean> {
    const result = await db.delete(channelReservations).where(eq(channelReservations.id, id)).returning();
    return result.length > 0;
  },
};
