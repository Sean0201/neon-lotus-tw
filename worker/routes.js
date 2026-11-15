/**
 * /api/<name> → api/<name>.js(Vercel 寫法,經 vercel-adapter 轉接)
 * 新增 API 時:在 api/ 加檔案,並在這裡 import + 加進 ROUTES。
 *
 * 綠界物流(api/logistics-*.js)不部署到 Cloudflare:前台結帳沒有使用,
 * 之後改接藍新物流。
 */
import * as adminBackfillPurchase from '../api/admin-backfill-purchase.js';
import * as adminListMembers from '../api/admin-list-members.js';
import * as adminMemberDetail from '../api/admin-member-detail.js';
import * as adminRefundOrder from '../api/admin-refund-order.js';
import * as adminSearchMembers from '../api/admin-search-members.js';
import * as hunt from '../api/hunt.js';
import * as newebpayCreate from '../api/newebpay-create.js';
import * as newebpayNotify from '../api/newebpay-notify.js';
import * as newebpayReturn from '../api/newebpay-return.js';
import * as notifyOrder from '../api/notify-order.js';
import * as rebuildSnapshot from '../api/rebuild-snapshot.js';
import * as threadsPublishDue from '../api/threads-publish-due.js';
import * as threadsTelegramWebhook from '../api/threads-telegram-webhook.js';
import * as tryon from '../api/tryon.js';

export const ROUTES = {
  'admin-backfill-purchase': adminBackfillPurchase,
  'admin-list-members': adminListMembers,
  'admin-member-detail': adminMemberDetail,
  'admin-refund-order': adminRefundOrder,
  'admin-search-members': adminSearchMembers,
  'hunt': hunt,
  'newebpay-create': newebpayCreate,
  'newebpay-notify': newebpayNotify,
  'newebpay-return': newebpayReturn,
  'notify-order': notifyOrder,
  'rebuild-snapshot': rebuildSnapshot,
  'threads-publish-due': threadsPublishDue,
  'threads-telegram-webhook': threadsTelegramWebhook,
  'tryon': tryon,
};
