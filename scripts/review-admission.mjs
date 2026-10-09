import { MarketAdmission } from './lib/market-admission.mjs';
const [action, id, flag, hours] = process.argv.slice(2);
if (!process.env.TAM_ADMISSION_STATE_DIR || !process.env.TAM_MARKET_ORIGIN) throw new Error('Set the private admission directory and market origin; this is an operator command, not a public API.');
const admission = new MarketAdmission({ directory: process.env.TAM_ADMISSION_STATE_DIR, origin: process.env.TAM_MARKET_ORIGIN });
if (action === 'list') console.log(JSON.stringify(admission.records().map(r => admission.publicRecord(r)), null, 2));
else if (['approve', 'reject'].includes(action) && id && (flag == null || flag === '--hours')) console.log(JSON.stringify(admission.review(id, action === 'approve' ? 'approved' : 'rejected', hours ? Number(hours) : 24), null, 2));
else throw new Error('Usage: review-admission.mjs list | approve <id> [--hours 24] | reject <id>. Approve only a buyer vetted by this seller.');
