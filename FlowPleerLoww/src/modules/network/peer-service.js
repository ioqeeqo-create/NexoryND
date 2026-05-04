class PeerRoomService {
  constructor(opts = {}) {
    this.maxPeersPerRoom = Number(opts.maxPeersPerRoom || 3)
  }

  getRoomLimit() {
    return this.maxPeersPerRoom
  }
}

module.exports = {
  PeerRoomService,
}
