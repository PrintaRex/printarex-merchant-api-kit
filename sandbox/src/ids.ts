import { randomBytes, randomUUID } from 'node:crypto';

const hex32 = (): string => randomUUID().replaceAll('-', '');

export const newOrderId = (): string => `ord_${hex32()}`;
export const newShipmentId = (): string => `shp_${hex32()}`;
export const newProductId = (): string => `prd_${hex32()}`;
export const newVariantId = (): string => `var_${hex32()}`;
export const newRequestId = (): string => `req_${hex32()}`;
export const newUuid = (): string => randomUUID();

/** Sandbox keys use the UAT format: `prx_uat_` + 43 base64url characters (32 random bytes). */
export const generateApiKey = (): string => `prx_uat_${randomBytes(32).toString('base64url')}`;
export const generateWebhookSecret = (): string => `whsec_${randomBytes(32).toString('base64url')}`;

export const API_KEY_PATTERN = /^prx_uat_[A-Za-z0-9_-]{43}$/;
export const KEY_IN_QUERY_PATTERN = /prx_(uat|live)_/i;
