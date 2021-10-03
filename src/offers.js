import wrap from './lib/promise-wrap'

const debug = require('debug')('lightning-charge')

// maximum wait time for long-polling
const maxWait = +process.env.MAX_WAIT || 600

module.exports = (app, payListen, model, auth, lnconf) => {
  const { newOffer } = model

  app.on('listening', server => server.timeout = maxWait*1000 + 500)

  app.param('offer', wrap(async (req, res, next, id) => {
    req.offer = await fetchOffer(req.params.offer)
    if (!req.offer) return res.sendStatus(404)
    next()
  }))

  app.get('/offers', auth, wrap(async (req, res) =>
    res.send(await listOffers())))

  app.get('/offer/:offer', auth, (req, res) =>
    res.send(req.offer))

  app.post('/offer', auth, wrap(async (req, res) =>
    res.status(201).send(await newOffer(req.body))))

  app.get('/offer/:offer/wait', auth, wrap(async (req, res) => {
    if (req.offer.status == 'paid')    return res.send(req.offer)
    if (req.offer.status == 'expired') return res.sendStatus(410)

    const expires_in = req.offer.expires_at - (Date.now()/1000|0)
        , timeout    = Math.min(+req.query.timeout || 300, expires_in, maxWait)
        , paid       = await payListen.register(req.offer.offer_id, timeout*1000)

    if (paid) res.send(paid)
    else res.sendStatus(timeout == expires_in ? 410 : 402)
    // @TODO remove listener on client disconnect
  }))

  app.delete('/offer/:offer', auth, wrap(async (req, res) => {
    await delOffer(req.params.offer, req.body.status)
    res.sendStatus(204)
  }))
}
