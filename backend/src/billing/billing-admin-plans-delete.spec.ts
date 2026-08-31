import { getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Connection, Model } from 'mongoose';
import { BillingAdminPlansService } from './billing-admin-plans.service';
import { BillingFeature, BillingFeatureSchema } from './schemas/billing-feature.schema';
import { BillingPlan, BillingPlanDocument, BillingPlanSchema } from './schemas/billing-plan.schema';
import { BillingPlanPrice, BillingPlanPriceSchema } from './schemas/billing-plan-price.schema';
import { BillingSubscription, BillingSubscriptionDocument, BillingSubscriptionSchema } from './schemas/billing-subscription.schema';

// Real-Mongo integration tests for the new deletePlan guard — a permanent
// delete is only safe when the plan has never had a subscription, since
// BillingSubscription.planId has no DB-level FK enforcement and would
// silently dangle otherwise.

const TEST_PREFIX = `jest-plan-delete-${Date.now()}`;

describe('BillingAdminPlansService.deletePlan (real Mongo)', () => {
  let connection: Connection;
  let service: BillingAdminPlansService;
  let planModel: Model<BillingPlanDocument>;
  let subscriptionModel: Model<BillingSubscriptionDocument>;

  beforeAll(async () => {
    const uri = process.env.MONGODB_URI ?? process.env.MONGO_URI;
    if (!uri) throw new Error('MONGODB_URI/MONGO_URI must be set to run these integration tests.');

    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri),
        MongooseModule.forFeature([
          { name: BillingPlan.name, schema: BillingPlanSchema },
          { name: BillingPlanPrice.name, schema: BillingPlanPriceSchema },
          { name: BillingFeature.name, schema: BillingFeatureSchema },
          { name: BillingSubscription.name, schema: BillingSubscriptionSchema },
        ]),
      ],
      providers: [BillingAdminPlansService],
    }).compile();

    connection = moduleRef.get(getModelToken(BillingPlan.name)).db;
    service = moduleRef.get(BillingAdminPlansService);
    planModel = moduleRef.get(getModelToken(BillingPlan.name));
    subscriptionModel = moduleRef.get(getModelToken(BillingSubscription.name));
  });

  afterAll(async () => {
    await planModel.deleteMany({ key: { $regex: `^${TEST_PREFIX}` } });
    await subscriptionModel.deleteMany({ organizationId: { $regex: `^${TEST_PREFIX}` } });
    await connection.close();
  });

  it('permanently deletes a plan and its prices when it has no subscription history', async () => {
    const plan = await service.createPlan({ key: `${TEST_PREFIX}-clean`, name: 'Clean Plan' });
    const price = await service.addPrice(plan._id.toString(), { currencyCode: 'INR', billingCycle: 'monthly', amount: 500, creditsGranted: 500 });

    await service.deletePlan(plan._id.toString());

    await expect(service.getPlan(plan._id.toString())).rejects.toThrow();
    const prices = await service.listPrices(plan._id.toString());
    expect(prices.find((p) => p._id.toString() === price._id.toString())).toBeUndefined();
  });

  it('rejects deleting a plan that has subscription history — archive it instead', async () => {
    const plan = await service.createPlan({ key: `${TEST_PREFIX}-subscribed`, name: 'Subscribed Plan' });
    await subscriptionModel.create({
      organizationId: `${TEST_PREFIX}-org`,
      planId: plan._id.toString(),
      planPriceId: 'fake-price-id',
      status: 'canceled',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(),
      createdBy: 'jest',
    });

    await expect(service.deletePlan(plan._id.toString())).rejects.toThrow('archive it instead');

    const stillExists = await service.getPlan(plan._id.toString());
    expect(stillExists).toBeTruthy();
  });

  it('throws NotFoundException when deleting an unknown plan id', async () => {
    await expect(service.deletePlan('000000000000000000000000')).rejects.toThrow();
  });
});
