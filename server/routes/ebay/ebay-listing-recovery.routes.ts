import type { Router, Request, Response } from 'express';
import { requireAuth, requirePermission } from '../middleware';
import { hasPermission } from '../../modules/identity';
import type { EbayListingRecoveryService } from '../../modules/channels/ebay-listing-sync';
import { listingFailure, listingFailureStatus } from './ebay-listing-errors';

export function registerEbayListingRecoveryRoutes(router: Router,
  service: Pick<EbayListingRecoveryService, 'inspect' | 'preview' | 'resume' | 'inspectProduct' | 'previewProduct' | 'resumeProduct'>, channelId: number): void {
  router.use('/api/ebay/listings/sync-jobs/:jobId', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/api/ebay/listings/sync-jobs/:jobId',requireAuth,requirePermission('channels','view'),async(req:Request,res:Response)=> {
    try { res.json(await service.inspect(req.params.jobId, channelId)); }
    catch (error) { res.status(listingFailureStatus(error)).json(listingFailure(error)); }
  });
  router.get('/api/ebay/listings/sync-jobs/:jobId/recovery',requireAuth,requirePermission('channels','view'),async(req:Request,res:Response)=> {
    try {
      const preview = await service.preview(req.params.jobId, channelId);
      const canRecover = await hasPermission(req.session.user!.id, 'inventory_planning', 'activate')
        && await hasPermission(req.session.user!.id, 'channels', 'edit');
      res.json({ ...preview, canRecover, requiredPermission: canRecover ? null : 'inventory_planning:activate and channels:edit' });
    } catch (error) { res.status(listingFailureStatus(error)).json(listingFailure(error)); }
  });
  router.post('/api/ebay/listings/sync-jobs/:jobId/recovery',requireAuth,requirePermission('channels','edit'),requirePermission('inventory_planning','activate'),async(req:Request,res:Response)=> {
    try { res.json(await service.resume(req.params.jobId, channelId, String(req.session.user!.id), req.body)); }
    catch (error) { res.status(listingFailureStatus(error)).json(listingFailure(error)); }
  });
  router.use('/api/ebay/listings/products/:productId', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/api/ebay/listings/products/:productId',requireAuth,requirePermission('channels','view'),async(req:Request,res:Response)=> {
    try { res.json(await service.inspectProduct(Number(req.params.productId), channelId)); }
    catch (error) { res.status(listingFailureStatus(error)).json(listingFailure(error)); }
  });
  router.get('/api/ebay/listings/products/:productId/recovery',requireAuth,requirePermission('channels','view'),async(req:Request,res:Response)=> {
    try {
      const preview = await service.previewProduct(Number(req.params.productId), channelId);
      const canRecover = await hasPermission(req.session.user!.id, 'inventory_planning', 'activate')
        && await hasPermission(req.session.user!.id, 'channels', 'edit');
      res.json({ ...preview, canRecover, requiredPermission: canRecover ? null : 'inventory_planning:activate and channels:edit' });
    } catch (error) { res.status(listingFailureStatus(error)).json(listingFailure(error)); }
  });
  router.post('/api/ebay/listings/products/:productId/recovery',requireAuth,requirePermission('channels','edit'),requirePermission('inventory_planning','activate'),async(req:Request,res:Response)=> {
    try { res.json(await service.resumeProduct(Number(req.params.productId), channelId, String(req.session.user!.id), req.body)); }
    catch (error) { res.status(listingFailureStatus(error)).json(listingFailure(error)); }
  });

}
