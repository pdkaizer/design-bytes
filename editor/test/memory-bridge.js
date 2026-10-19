'use strict';

// An in-memory bridge that behaves like the server: versions, and 409 on a stale write.
module.exports = function memoryBridge(initial = null) {
  const file = { data: initial, version: initial ? 1 : null };
  return {
    file,
    writes: 0,
    async readData() { return JSON.parse(JSON.stringify({ data: file.data, version: file.version })); },
    async writeData(name, data, version) {
      if (version !== file.version) throw Object.assign(new Error('Changed since it was read'), { status: 409, data: {} });
      this.writes++;
      file.data = JSON.parse(JSON.stringify(data));
      file.version = (file.version || 0) + 1;
      return { version: file.version };
    },
  };
};
