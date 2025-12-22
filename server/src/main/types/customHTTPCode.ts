// Standard HTTP Status Codes
export const SUCCESS = 200;
export const CREATED = 201;
export const NO_CONTENT = 204;
export const BAD_REQUEST = 400;
export const UNAUTHORIZED = 401;
export const GENERAL_FORBIDDEN = 403;
// XXX DO NOT USE THIS - use a specific code
export const DO_NOT_USE___NOT_FOUND___DO_NOT_USE = 404;
export const TOO_MANY_REQUESTS = 429;

// Custom HTTP Status Codes
export const TOKEN_EXPIRED = 405;
export const CONFIRMATION_EMAIL_SENT = 210;
export const USER_NOT_FOUND = 406;
export const CONFLICT = 409;
export const BUDGET_NOT_ENOUGH = 410;
export const OUT_OF_BUSINESS_HOURS = 411;
export const BUYER_CREDIT_CARD_NOT_FOUND = 412;
export const LEAD_MISSING_CATEGORY = 413;
export const USER_MISSING_CATEGORY = 418;
export const LEAD_NOT_REASSIGNABLE = 414;
export const CANNOT_REMOVE_CATEGORY = 414;

export const COUNTY_OR_STATE_NOT_FOUND = 414;
// XXX DO NOT USE THIS - use a specific code
export const DO_NOT_USE___GENERIC_ERROR___DO_NOT_USE = 500;
export const SENT_DATE_IN_PAST = 501;
export const LEAD_ALREADY_PAID = 502;
export const ERROR_CREATING_COUNTY_BID = 503;
export const ERROR_UPDATING_LEAD = 504;
export const ERROR_CALCULATING_BUDGET = 508;
export const PAYMENT_METHOD_FAILURE = 505;
export const CHARGE_FAILURE = 506;

// You can add other custom statuses as needed, ensuring they don't overlap with standard codes.