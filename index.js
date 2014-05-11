var BitField = require('bitfield')
var bncode = require('bncode')
var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')
var Rusha = require('rusha-browserify') // Fast SHA1 (works in browser)

var BITFIELD_GROW = 1000
var PIECE_LENGTH = 16 * 1024

function sha1 (buf) {
  return (new Rusha()).digestFromBuffer(buf)
}

module.exports = function (metadata) {

  inherits(ut_metadata, EventEmitter)

  function ut_metadata (wire) {
    EventEmitter.call(this)

    this._wire = wire

    this._metadataComplete = false
    this._metadataSize = null
    this._remainingRejects = null // how many reject messages to tolerate before quitting
    this._fetching = false

    // The largest .torrent file that I know of is ~1-2MB, which is ~100 pieces.
    // Therefore, cap the bitfield to 1,000 bits so a malicious peer can't make it grow
    // to fill all memory.
    this._bitfield = new BitField(0, { grow: BITFIELD_GROW })

    if (Buffer.isBuffer(metadata)) {
      var info = null
      try {
        // if buffer fails to decode or there is no info key, then metadata is corrupt
        info = bncode.encode(bncode.decode(metadata).info)
      } catch (err) {
        throw new Error('`ut_metadata` constructed with corrupt/invalid metadata')
      }

      if (info)
        this._gotMetadata(info)
    }
  }

  ut_metadata.prototype.onHandshake = function (infoHash, peerId, extensions) {
    this._infoHash = infoHash
  }

  ut_metadata.prototype.onExtendedHandshake = function (handshake) {
    if (!handshake.m.ut_metadata) {
      return this.emit('warning', new Error('Peer does not support ut_metadata'))
    }
    if (!handshake.metadata_size) {
      return this.emit('warning', new Error('Peer does not have metadata'))
    }

    this._metadataSize = handshake.metadata_size
    this._numPieces = Math.ceil(this._metadataSize / PIECE_LENGTH)
    this._remainingRejects = this._numPieces * 2

    if (this._fetching) {
      this._requestPieces()
    }
  }

  ut_metadata.prototype.onMessage = function (buf) {
    var dict, trailer
    try {
      var str = buf.toString()
      var trailerIndex = str.indexOf('ee') + 2
      dict = bncode.decode(str.substring(0, trailerIndex))
      trailer = buf.slice(trailerIndex)
    } catch (err) {
      // drop invalid messages
      return
    }

    switch (dict.msg_type) {
      case 0:
        // ut_metadata request (from peer)
        // example: { 'msg_type': 0, 'piece': 0 }
        this._onRequest(dict.piece)
        break
      case 1:
        // ut_metadata data (in response to our request)
        // example: { 'msg_type': 1, 'piece': 0, 'total_size': 3425 }
        this._onData(dict.piece, trailer, dict.total_size)
        break
      case 2:
        // ut_metadata reject (peer doesn't have piece we requested)
        // { 'msg_type': 2, 'piece': 0 }
        this._onReject(dict.piece)
        break
    }
  }

  // Expose high-level, friendly API (fetch/cancel)
  ut_metadata.prototype.fetch = function () {
    if (this._metadataComplete) {
      return
    }
    this._fetching = true
    if (this._metadataSize) {
      this._requestPieces()
    }
  }

  ut_metadata.prototype.cancel = function () {
    this._fetching = false
  }

  ut_metadata.prototype._send = function (dict, trailer) {
    var buf = bncode.encode(dict)
    if (Buffer.isBuffer(trailer)) {
      buf = Buffer.concat([buf, trailer])
    }
    this._wire.extended('ut_metadata', buf)
  }

  ut_metadata.prototype._request = function (piece) {
    this._send({ msg_type: 0, piece: piece })
  }

  ut_metadata.prototype._data = function (piece, buf, totalSize) {
    var msg = { msg_type: 1, piece: piece }
    if (typeof totalSize === 'number') {
      msg.total_size = totalSize
    }
    this._send(msg, buf)
  }

  ut_metadata.prototype._reject = function (piece) {
    this._send({ msg_type: 2, piece: piece })
  }

  ut_metadata.prototype._onRequest = function (piece) {
    if (!this._metadataComplete) {
      return
    }
    var start = piece * PIECE_LENGTH
    var end = start + PIECE_LENGTH
    if (end > this._metadataSize) {
      end = this._metadataSize
    }
    var buf = this.metadata.slice(start, end)
    this._data(piece, buf, this._metadataSize)
  }

  ut_metadata.prototype._onData = function (piece, buf, totalSize) {
    if (buf.length > PIECE_LENGTH) {
      return
    }
    buf.copy(this.metadata, piece * PIECE_LENGTH)
    this._bitfield.set(piece)
    this._checkDone()
  }

  ut_metadata.prototype._onReject = function (piece) {
    if (this._remainingRejects > 0 && this._fetching) {
      // If we haven't been rejected too much, then try to request the piece again
      this._request(piece)
      this._remainingRejects -= 1
    } else {
      this.emit('warning', new Error('Peer sent "reject" too much'))
    }
  }

  ut_metadata.prototype._requestPieces = function () {
    this.metadata = new Buffer(this._metadataSize)

    for (var piece = 0; piece < this._numPieces; piece++) {
      this._request(piece)
    }
  }

  ut_metadata.prototype._checkDone = function () {
    var done = true
    for (var piece = 0; piece < this._numPieces; piece++) {
      if (!this._bitfield.get(piece)) {
        done = false
        break
      }
    }
    if (!done) return

    try {
      // if buffer fails to decode, then data was corrupt
      bncode.decode(this.metadata)
    } catch (err) {
      return this._failedMetadata()
    }

    // check hash
    if (sha1(this.metadata) === this._infoHash.toString('hex')) {
      this._gotMetadata(this.metadata)
    } else {
      this._failedMetadata()
    }
  }

  ut_metadata.prototype._gotMetadata = function (_metadata) {
    this.cancel()
    this.metadata = _metadata
    this._metadataComplete = true
    this._metadataSize = this.metadata.length
    this._wire.extendedHandshake.metadata_size = this._metadataSize
    this.emit('metadata', bncode.encode({ info: bncode.decode(this.metadata) }))
  }

  ut_metadata.prototype._failedMetadata = function () {
    // reset bitfield & try again
    this._bitfield = new BitField(0, { grow: BITFIELD_GROW })
    this._remainingRejects -= this._numPieces
    if (this._remainingRejects > 0) {
      this._requestPieces()
    } else {
      this.emit('warning', new Error('Peer sent invalid metadata'))
    }
  }

  return ut_metadata
}
