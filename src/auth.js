'use strict';
/**
 * Lightweight identity + role gate.
 * NOTE: this is NOT authentication. The caller declares who they are via the
 * X-User / X-Role headers. It exists so role separation and segregation-of-duties
 * rules can be enforced and audited. Put real SSO/JWT auth in front before production.
 */
const { HttpError } = require('./db');

const ROLES = ['ADMIN', 'PROCUREMENT', 'COMPLIANCE', 'FINANCE', 'WAREHOUSE'];

function identity(req, res, next) {
  if (req.path === '/health') return next();
  const user = (req.get('x-user') || '').trim();
  const role = (req.get('x-role') || '').trim().toUpperCase();
  if (!user || !ROLES.includes(role)) {
    return next(new HttpError(401, 'Missing identity: send X-User and X-Role headers',
      { roles: ROLES }));
  }
  req.user = user;
  req.role = role;
  next();
}

/** ADMIN is always allowed; otherwise the caller's role must be listed. */
const allow = (...roles) => (req, res, next) => {
  if (req.role === 'ADMIN' || roles.includes(req.role)) return next();
  next(new HttpError(403, `Role ${req.role} may not perform this action`, { required: roles }));
};

module.exports = { identity, allow, ROLES };
