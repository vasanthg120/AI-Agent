import { FilterQuery } from 'mongoose';
import { Deal } from './schemas/deal.schema';

// What "in the pipeline" means, in one place, for every pipeline figure (the
// Dashboard's Overall Pipeline, its Pipeline box and Pipeline Health) and the
// lists they open.
//
// For most CRMs the pipeline is the open deals. A CRM whose pipeline is
// something else says so on each deal (`inPipeline`, written by its sync) —
// Hoops: jobs still in progress, which are won sales (2026-11-11, from the
// user's Hoops jobs report: "Work in progress" = every job neither completed
// nor voided), while its quotes waiting on a customer are open but not in it.
// A deal without the flag falls back to "open".

/** Query condition: the deal is in the pipeline. */
export const IN_PIPELINE: FilterQuery<Deal> = {
  $or: [{ inPipeline: true }, { inPipeline: { $exists: false }, dealStatus: 'open' }],
};

/** Aggregation expression: true when the deal is in the pipeline. */
export const IN_PIPELINE_EXPR = {
  $cond: [{ $eq: [{ $type: '$inPipeline' }, 'missing'] }, { $eq: ['$dealStatus', 'open'] }, { $eq: ['$inPipeline', true] }],
};
