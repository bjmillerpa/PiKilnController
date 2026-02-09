'use strict';

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

class Logger extends EventEmitter {
  constructor(logDir) {
    super();
    this._logDir = logDir;
    this._currentFile = null;
    this._currentDate = null;
    this._ensureDir();
  }

  _ensureDir() {
    if (!fs.existsSync(this._logDir)) {
      fs.mkdirSync(this._logDir, { recursive: true });
    }
  }

  _dateStr() {
    const d = new Date();
    return d.getFullYear().toString() +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0');
  }

  _timestamp() {
    const d = new Date();
    return this._dateStr() + '_' +
      String(d.getHours()).padStart(2, '0') +
      String(d.getMinutes()).padStart(2, '0') +
      String(d.getSeconds()).padStart(2, '0');
  }

  _openLog() {
    const dateStr = this._dateStr();
    if (dateStr !== this._currentDate) {
      this._currentDate = dateStr;
      this._currentFile = path.join(this._logDir, dateStr + '.log');
    }
  }

  _appendToFile(line) {
    this._openLog();
    try {
      fs.appendFileSync(this._currentFile, line + '\n');
    } catch (err) {
      console.error('Failed to write log:', err.message);
    }
  }

  log(msg) {
    const line = `${this._timestamp()}: ${msg}`;
    this._appendToFile(line);
    this.emit('log', line);
    console.log(line);
  }

  message(msg) {
    this.emit('message', msg);
  }

  error(msg) {
    const line = `${this._timestamp()}: ERROR: ${msg}`;
    this._appendToFile(line);
    this.emit('log', line);
    this.emit('message', `ERROR: ${msg}`);
    console.error(line);
  }
}

module.exports = { Logger };
