const EventEmitter = require('events');

class EventBus extends EventEmitter {
  constructor() {
    super();
    this.stats = {
      tradeEvents: 0,
      transferEvents: 0,
      startTime: Date.now()
    };
  }

  emitTrade(tradeData) {
    this.stats.tradeEvents++;
    this.emit('trade', tradeData);
  }

  emitTransfer(transferData) {
    this.stats.transferEvents++;
    this.emit('transfer', transferData);
  }

  getStats() {
    return {
      ...this.stats,
      uptime: Date.now() - this.stats.startTime
    };
  }
}

let instance = null;

function getInstance() {
  if (!instance) {
    instance = new EventBus();
  }
  return instance;
}

module.exports = { getInstance };
