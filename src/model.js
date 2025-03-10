import { nanoid } from 'nanoid'
import { toMsat } from './lib/exchange-rate'

const debug  = require('debug')('lightning-charge')
    , status = inv => inv.pay_index ? 'paid' : inv.expires_at > now() ? 'unpaid' : 'expired'
    , format = inv => ({ ...inv, status: status(inv), msatoshi: (inv.msatoshi || null), metadata: JSON.parse(inv.metadata) })
    , now    = _ => Date.now() / 1000 | 0

// @XXX invoices that accept any amount are stored as msatoshi='' (empty string)
// and converted to null when formatted. this is due to sqlite's lack of support
// for ALTER TABLE, which makes dropping the NOT NULL constraint complicated
// (requires creating a new table, copying over the data and replacing the old one).
// This will eventually be done in a future release.

const defaultDesc = process.env.INVOICE_DESC_DEFAULT || 'Lightning Charge Invoice'

module.exports = (db, ln) => {
  const newInvoice = async props => {
    const { currency, amount, expiry, description, metadata, webhook } = props

    const id       = nanoid()
        , msatoshi = props.msatoshi ? ''+props.msatoshi : currency ? await toMsat(currency, amount) : ''
        , desc     = props.description ? ''+props.description : defaultDesc
        , lninv    = await ln.invoice(msatoshi || 'any', id, desc, expiry)

    const invoice = {
      id, msatoshi, description: desc
    , quoted_currency: currency, quoted_amount: amount
    , rhash: lninv.payment_hash, payreq: lninv.bolt11
    , expires_at: lninv.expires_at, created_at: now()
    , metadata: JSON.stringify(metadata || null)
    }

    debug('saving invoice:', invoice)
    await db('invoice').insert(invoice)

    if (webhook) await addHook(id, webhook)

    return format(invoice)
  }

  const listInvoices = _ =>
    db('invoice').then(rows => rows.map(format))

  const fetchInvoice = id =>
    db('invoice').where({ id }).first().then(r => r && format(r))

  const delInvoice = async (id, status) => {
    await ln.delinvoice(id, status)
    await db('invoice').where({ id }).del()
  }

  const markPaid = (id, pay_index, paid_at, msatoshi_received) =>
    db('invoice').where({ id, pay_index: null })
                 .update({ pay_index, paid_at, msatoshi_received })

  const getLastPaid = _ =>
    db('invoice').max('pay_index as index')
                 .first().then(r => r.index)

  const delExpired = ttl =>
    db('invoice').select('id')
      // fetch unpaid invoices expired over `ttl` ago
      .where({ pay_index: null })
      .where('expires_at', '<', now() - ttl)
      // try fetching the invoices from c-lightning to make sure they're deleted there.
      // invoices that still exists on c-lightning won't be deleted from charge.
      // c-lightning should be configured for automatic cleanup via autocleaninvoice
      .then(invs => Promise.all(invs.map(inv =>
        ln.listinvoices(inv.id).then(r => r.invoices.length ? null : inv.id)
      )))
      .then(ids => ids.filter(id => id != null))
      // delete all expired invoices not found on c-lightning
      .then(ids => ids.length && db('invoice').whereIn('id', ids).delete())

  const addHook = (invoice_id, url) =>
    db('invoice_webhook').insert({ invoice_id, url, created_at: now() })

  const getHooks = invoice_id =>
    db('invoice_webhook').where({ invoice_id })

  const logHook = (id, err, res) =>
    db('invoice_webhook').where({ id }).update(
      !err ? { requested_at: now(), success: true,  resp_code: res.status }
           : { requested_at: now(), success: false, resp_error: err })

  const newOffer = async props => {
    const { webhook } = props;
    let { metadata } = props;

    const map = {
      amount: {
        prefix: '',
        wrap: false,
      },
      description: {
        prefix: '',
        default: 'Lightning Charge Offer',
        wrap: false,
      },
      vendor: {
        prefix: '',
        wrap: false,
      },
      label: {
        prefix: '',
        wrap: false,
      },
      quantity_min: {},
      quantity_max: {},
      absolute_expiry: {},
      recurrence: {},
      recurrence_base: {},
      recurrence_paywindow: {},
      recurrence_limit: {},
      single_use: {},
    };

    let amount = 'any';
    let quoted_currency = '';
    let quoted_amount = '';

    if (props.currency && props.amount) {
      quoted_currency = props.currency;
      quoted_amount = props.amount;

      //amount = await toMsat(quoted_currency, quoted_amount);
      amount = quoted_amount + quoted_currency;
    } else if (props.amount) {
      amount = props.amount;
    } else if (props.msatoshi) {
      amount = props.msatoshi;
    }

    props.amount = amount;

    let offer = {};
    const args = [];

    for (const [key, info] of Object.entries(map)) {
      let value = props[key];
      const wrap = typeof info.wrap != 'undefined' ? info.wrap : true;
      const prefix = typeof info.prefix != 'undefined' ? info.prefix : `${key}=`;
      const suffix = typeof info.suffix != 'undefined' ? info.suffix : '';

      if (typeof value === 'undefined') {
        if (info.default) {
          value = info.default;
        } else {
          continue;
        }
      }
       
      offer[key] = value;

      value += suffix;

      if (wrap) {
        value = `"${value}"`;
      }

      args.push(`${prefix}${value}`);
    }

    const response = await ln.offer.apply(ln, args);

    const id = nanoid();
    metadata = JSON.stringify(metadata || null);

    if (response && response.offer_id) {
      offer = {
        ...offer,
        ...response,
        quoted_amount,
        quoted_currency,
        metadata,
        created_at: now()
      }

      debug('saving offer:', offer)
      await db('offer').insert(offer)

      if (webhook) await addHook(id, webhook)

      return format(offer)
    }
  }

  return { newInvoice, listInvoices, fetchInvoice, delInvoice
         , getLastPaid, markPaid, delExpired
         , addHook, getHooks, logHook, newOffer }
}

