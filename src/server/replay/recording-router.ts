import {Router,type Request,type Response,type NextFunction} from 'express';
import {z} from 'zod';
import type {Principal} from '../runtime/security.js';
import {ApiError} from '../runtime/errors.js';
import type {RecordingController} from './recording-controller.js';
import type {RecordingExportRegistry} from './recording-registry.js';

const id=z.string().uuid(),sourceReview=z.object({id:z.string().min(1).max(160),revision:z.number().int().nonnegative(),textHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
/** Mount under the existing authenticated /api/owner router; it additionally checks role and scope. */
export function createRecordingRouter(controller:RecordingController,registry?:RecordingExportRegistry){
  const router=Router(),principal=(res:Response)=>{const value=res.locals.principal as Principal|undefined;if(!value)throw new ApiError(401,'session_required','Sign in to manage recordings.');return value;};
  const route=(handler:(req:Request,res:Response)=>unknown)=>(req:Request,res:Response,next:NextFunction)=>{try{res.set('Cache-Control','no-store');const value=['POST','DELETE'].includes(req.method)?controller.command(principal(res),String(req.headers['idempotency-key']??''),{method:req.method,path:req.path,body:req.body},()=>handler(req,res)):handler(req,res);if(!res.headersSent)res.json(value);}catch(error){next(error instanceof z.ZodError?new ApiError(400,'invalid_request','The recording request is invalid.'):error);}};
  router.get('/recordings',route((_req,res)=>controller.list(principal(res))));
  router.post('/recordings/start',route((req,res)=>controller.start(principal(res),z.object({sessionId:z.string().min(1).max(160).optional()}).strict().parse(req.body))));
  router.post('/recordings/:id/stop',route((req,res)=>{z.object({}).strict().parse(req.body);return controller.stop(principal(res),id.parse(req.params.id));}));
  router.delete('/recordings/:id',route((req,res)=>{controller.remove(principal(res),id.parse(req.params.id));return {removed:true};}));
  router.get('/recordings/:id/review',route((req,res)=>controller.review(principal(res),id.parse(req.params.id))));
  router.post('/recordings/:id/media',async(req,res,next)=>{try{res.set('Cache-Control','no-store');const owner=principal(res),recordingId=id.parse(req.params.id),body=z.object({mediaId:z.string().min(1).max(120)}).strict().parse(req.body);res.json(await controller.commandAsync(owner,String(req.headers['idempotency-key']??''),{method:req.method,path:req.path,body},()=>controller.attachMedia(owner,recordingId,body.mediaId)));}catch(error){next(error instanceof z.ZodError?new ApiError(400,'invalid_request','The recording request is invalid.'):error);}});
  router.delete('/recordings/:id/media/:mediaId',route((req,res)=>controller.detachMedia(principal(res),id.parse(req.params.id),String(req.params.mediaId))));
  router.get('/recordings/:id/media/:mediaId',route((req,res)=>{const asset=controller.readMedia(principal(res),id.parse(req.params.id),String(req.params.mediaId));res.type(asset.mime).set('Content-Disposition','inline').send(Buffer.from(asset.bytes));}));
  router.post('/recordings/:id/review',route((req,res)=>controller.approve(principal(res),id.parse(req.params.id),z.object({captureRevision:z.number().int().positive(),digest:z.string().regex(/^[a-f0-9]{64}$/),reviewedSources:z.array(sourceReview).max(10000),reviewedOutputHashes:z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10000),reviewedMedia:z.array(z.object({id:z.string().min(1).max(120),hash:z.string().regex(/^[a-f0-9]{64}$/),visualReviewed:z.literal(true),audioReviewed:z.literal(true)}).strict()).max(12).optional(),metadataReviewed:z.literal(true)}).strict().parse(req.body))));
  router.post('/recordings/:id/export',route((req,res)=>controller.export(principal(res),id.parse(req.params.id),z.object({reviewReceiptId:id}).strict().parse(req.body).reviewReceiptId)));
  router.post('/recordings/:id/publish',route((req,res)=>{z.object({}).strict().parse(req.body);const record=controller.list(principal(res)).items.find(r=>r.id===id.parse(req.params.id));if(!record?.exportId||record.status!=='exported'||!registry)throw new ApiError(409,'recording_export_required','Create a reviewed private export before publishing.');return registry.queue(record.exportId);}));
  router.get('/recordings/:id/download',route((req,res)=>{const record=controller.list(principal(res)).items.find(r=>r.id===id.parse(req.params.id));if(!record?.exportId||record.status!=='exported'||!registry)throw new ApiError(410,'recording_unavailable','This export is unavailable.');const asset=registry.read(record.exportId);res.type(asset.mime).set('Content-Disposition',`attachment; filename="${record.exportId}.json"`).send(Buffer.from(asset.bytes));}));
  return router;
}
