/*
** © 2012 by YOUSURE Tarifvergleich GmbH. Licensed under MIT License
*/

module.exports = database;

var mongo = require('mongodb');
var EventEmitter = require('events').EventEmitter;
var retry = require('retry').operation;

function parseDefString(str) {
  str=String(str || undefined);
  str = str.split(':');
  if (str.length === 1) {
    str.push('27017');
  } else if(!str.length || (str.length > 2)) {
    throw new Error('Invalid Database Specification (too many parts)');
  }
  str = { host:str[0], port:parseInt(str[1],10) };
  if (isNaN(str.port)) throw new Error('Invalid Database Specification (bad port)');
  return str;
}
function makeServer(def, opts) {
  return new mongo.Db(def.host, def.port, opts);
}
function makeDefinition(def) {
  def = ('object' == typeof def) ? def : parseDefString(def);
  if (def.replset) {
    def.replset = String(def.replset);
    if (!def.servers || !def.servers.length) throw new Error('Invalid Database Definition (missing servers)');
    def.servers = def.servers.map(function(def) {
      def = ('object' == typeof def) ? def : parseDefString(def);
      def.port = def.port || 27017;
      if (!def.host || isNaN(def.port)) throw new Error('Invalid Database Definition (bad servers)');
      return def;
    }).map(function(sdef) {
      return makeServer(sdef, def.options);
    });
    def.options = def.options || { auto_reconnect:true };
    def = new mongo.ReplSetServers(ctx.config.servers.map(makeServer), { rs_name:def.replset });
  } else {
    def.port = def.port || 27017;
    if (!def.host || isNaN(def.port)) throw new Error('Invalid Database Definition (bad servers)');
    def.options = def.options || { auto_reconnect:true };
    def = makeServer(def, def.options);
  }
}
function database(def, name) {
  var ctx = {
    name:String(name),
    timeout:(def.timeout || 30) * 1000,
    user:def.username,
    pass:def.password
  };
  var obj = {};

  Object.defineProperty(ctx, 'define', { value:database.define.bind(obj, ctx, def) });
  Object.defineProperty(ctx, 'retime', { value:database.retime.bind(obj, ctx) });
  Object.defineProperty(ctx, 'open', { value:database.open.bind(obj, ctx) });
  Object.defineProperty(ctx, 'auth', { value:database.auth.bind(obj, ctx) });
  Object.defineProperty(ctx, 'connect', { value:database.connect.bind(obj, ctx) });
  Object.defineProperty(ctx, 'close', { value:database.close.bind(obj, ctx) });

  Object.defineProperty(obj, 'name', { value:ctx.name });
  Object.defineProperty(obj, 'find', { value:database.find.bind(obj, ctx) });
  Object.defineProperty(obj, 'update', { value:database.update.bind(obj, ctx) });
  Object.defineProperty(obj, 'upsert', { value:database.upsert.bind(obj, ctx) });
  Object.defineProperty(obj, 'insert', { value:database.insert.bind(obj, ctx) });
  Object.defineProperty(obj, 'remove', { value:database.remove.bind(obj, ctx) });
  Object.defineProperty(obj, 'file', { value:database.file.bind(obj, ctx) });
  Object.defineProperty(obj, 'unlink', { value:database.unlink.bind(obj, ctx) });

  return obj;
}
database.define = function define(ctx, def) {
  return ctx.srv = makeDefinition(JSON.parse(JSON.stringify(def)));
};
database.retime = function retime(ctx) {
  clearTimeout(ctx.timer);
  setTimeout(ctx.close, ctx.timeout);
};
database.open = function open(ctx, callback) {
  if (ctx.db) {
    ctx.retime();
    return callback(undefined, ctx.db);
  }
  var op = retry();
  op.attempt(function(attempt) {
    var db = ctx.define();
    db.open(function(err, db) {
      if (retry.retry(err)) return ctx.emit('debug', err);
      err = retry.mainError();
      if (err) ctx.emit('error', err);
      if (db) ctx.retime();
      return callback(err, db);
    });
  });
};
database.auth = function auth(ctx, callback) {
  ctx.open(function opened(err, db) {
    if (err) return callback(err);
    if (!dbuser) return callback(undefined, db);
    var op = retry();
    op.attempt(function(attempt) {
      ctx.retime();
      db.authenticate(ctx.user, ctx.pass, function(err) {
        if (retry.retry(err)) return ctx.emit('debug', err);
        err = retry.mainError();
        if (err) ctx.emit('error', err);
        return callback(err, db);
      });
    });
  });
};
database.connect = function connect(ctx, callback) {
  var op = retry();
  op.attempt(function(attempt) {
    ctx.auth(function(err, db) {
      if (retry.retry(err)) return ctx.emit('debug', err);
      err = retry.mainError();
      if (err) ctx.emit('error', err);
      ctx.retime();
      return callback(err, ctx.db=db);
    });
  });
};
database.close = function close(ctx) {
  if (!ctx.db) return;
  ctx.db.close();
  delete ctx.db;
};
database.find = function find(ctx, collection, query, fields, callback) {
  var opctx = {
    dbctx:ctx,
    collection:collection,
    query:query,
    fields:fields
  };
  var hdl = makeHandle(opctx, callback);
  Object.defineProperty(ctx, 'run', { value:database.find.run.bind(hdl, opctx) });
  process.nextTick(ctx.run);
  return hdl;
};
database.find.run = function run(ctx) {
  var op = retry();
  op.attempt(function(attempt) {
    ctx.dbctx.connect(function(err, db) {
      if (retry.retry(err)) return ctx.dbctx.emit('debug', err);
      err = retry.mainError();
      if (err) {
        ctx.dbctx.emit('error', err);
        ctx.complete(err);
        return;
      }
      db.collection(ctx.collection, function(err, coll) {
        if (retry.retry(err)) return ctx.dbctx.emit('debug', err);
        err = retry.mainError();
        if (err) {
          ctx.dbctx.emit('error', err);
          ctx.complete(err);
          return;
        }
        ctx.dbctx.retime();
        ctx.complete(undefined, cursor(coll, ctx.dbctx.retime, ctx.query, ctx.fields));
      });
    });
  });
};
database.update = function update(ctx, collection, query, document, callback) {
  var opctx = {
    dbctx:ctx,
    collection:collection,
    query:query,
    document:document
  };
  var hdl = makeHandle(opctx, callback);
  Object.defineProperty(ctx, 'run', { value:database.find.run.bind(hdl, opctx) });
  process.nextTick(ctx.run);
  return hdl;
};
database.update.run = function run(ctx) {
  var op = retry();
  op.attempt(function(attempt) {
    ctx.dbctx.connect(function(err, db) {
      if (retry.retry(err)) return ctx.dbctx.emit('debug', err);
      err = retry.mainError();
      if (err) {
        ctx.dbctx.emit('error', err);
        ctx.complete(err);
        return;
      }
      db.collection(ctx.collection, function(err, coll) {
        if (retry.retry(err)) return ctx.dbctx.emit('debug', err);
        err = retry.mainError();
        if (err) {
          ctx.dbctx.emit('error', err);
          ctx.complete(err);
          return;
        }
        ctx.dbctx.retime();
        coll.update(ctx.query, ctx.document, { safe:true, multi:true }, ctx.complete);
      });
    });
  });
};
database.upsert = function upsert(ctx, collection, query, document, callback) {
  var opctx = {
    dbctx:ctx,
    collection:collection,
    query:query,
    document:document
  };
  var hdl = makeHandle(opctx, callback);
  Object.defineProperty(ctx, 'run', { value:database.find.run.bind(hdl, opctx) });
  process.nextTick(ctx.run);
  return hdl;
};
database.upsert.run = function run(ctx) {
  var op = retry();
  op.attempt(function(attempt) {
    ctx.dbctx.connect(function(err, db) {
      if (retry.retry(err)) return ctx.dbctx.emit('debug', err);
      err = retry.mainError();
      if (err) {
        ctx.dbctx.emit('error', err);
        ctx.complete(err);
        return;
      }
      db.collection(ctx.collection, function(err, coll) {
        if (retry.retry(err)) return ctx.dbctx.emit('debug', err);
        err = retry.mainError();
        if (err) {
          ctx.dbctx.emit('error', err);
          ctx.complete(err);
          return;
        }
        ctx.dbctx.retime();
        coll.update(ctx.query, ctx.document, { safe:true, multi:false, upsert:true }, ctx.complete);
      });
    });
  });
};
database.insert = function insert(ctx, collection, document, callback) {
  var opctx = {
    dbctx:ctx,
    collection:collection,
    document:document
  };
  var hdl = makeHandle(opctx, callback);
  Object.defineProperty(ctx, 'run', { value:database.find.run.bind(hdl, opctx) });
  process.nextTick(ctx.run);
  return hdl;
};
database.insert.run = function run(ctx) {
  var op = retry();
  op.attempt(function(attempt) {
    ctx.dbctx.connect(function(err, db) {
      if (retry.retry(err)) return ctx.dbctx.emit('debug', err);
      err = retry.mainError();
      if (err) {
        ctx.dbctx.emit('error', err);
        ctx.complete(err);
        return;
      }
      db.collection(ctx.collection, function(err, coll) {
        if (retry.retry(err)) return ctx.dbctx.emit('debug', err);
        err = retry.mainError();
        if (err) {
          ctx.dbctx.emit('error', err);
          ctx.complete(err);
          return;
        }
        ctx.dbctx.retime();
        coll.insert(ctx.document, { safe:true }, ctx.complete);
      });
    });
  });
};
database.remove = function remove(ctx, collection, query, callback) {
  var opctx = {
    dbctx:ctx,
    collection:collection,
    query:query
  };
  var hdl = makeHandle(opctx, callback);
  Object.defineProperty(ctx, 'run', { value:database.find.run.bind(hdl, opctx) });
  process.nextTick(ctx.run);
  return hdl;
};
database.remove.run = function run(ctx) {
  var op = retry();
  op.attempt(function(attempt) {
    ctx.connect(function(err, db) {
      if (retry.retry(err)) return ctx.emit('debug', err);
      err = retry.mainError();
      if (err) {
        ctx.emit('error', err);
        ctx.complete(err);
        return;
      }
      db.collection(ctx.collection, function(err, coll) {
        if (retry.retry(err)) return ctx.dbctx.emit('debug', err);
        err = retry.mainError();
        if (err) {
          ctx.dbctx.emit('error', err);
          ctx.complete(err);
          return;
        }
        ctx.retime();
        coll.remove(ctx.query, { safe:true }, ctx.complete);
      });
    });
  });
};
database.file = function file(ctx, name, meta, callback) {
  var opctx = {
    dbctx:ctx,
    name:name,
    mode:meta?'w':'r',
    meta:meta||{}
  };
  var hdl = makeHandle(opctx, callback);
  Object.defineProperty(ctx, 'run', { value:database.file.run.bind(hdl, opctx) });
  process.nextTick(ctx.run);
  return hdl;
};
database.file.run = function run(ctx) {
  var gshdl = this;
  var op = retry();
  op.attempt(function(attempt) {
    ctx.connect(function(err, db) {
      if (retry.retry(err)) return ctx.dbctx.emit('debug', err);
      err = retry.mainError();
      if (err) {
        ctx.dbctx.emit('error', err);
        ctx.complete(err);
        return;
      }
      var store = new mongo.GridStore(db, ctx.name, ctx.mode, ctx.meta);
      store.open(function (err, store) {
        if (retry.retry(err)) return ctx.dbctx.emit('debug', err);
        err = retry.mainError();
        ctx.store = store;
        ctx.dbctx.retime();
        Object.defineProperty(gshdl, 'size', { value:store.size });
        Object.defineProperty(gshdl, 'content_type', { value:store.contentType });
        Object.defineProperty(gshdl, 'created', { value:store.uploadDate });
        Object.defineProperty(gshdl, 'metadata', { value:store.metadata });
        if (ctx.mode==='r') {
          Object.defineProperty(gshdl, 'stream', { value:database.file.read.bind(gshdl, ctx) });
        } else {
          Object.defineProperty(gshdl, 'stream', { value:database.file.write.bind(gshdl, ctx) });
        }
        ctx.complete(undefined, gshdl);
      });

    });
  });
};
database.file.write = function(ctx) {
  ctx.dbctx.retime();
  return WriteStream(ctx.store, ctx.dbctx.retime);
};
database.file.read = function(ctx) {
  ctx.dbctx.retime();
  var data=[];
  var stream = ctx.store.stream(true);
  stream.on('data', ctx.dbctx.retime);
};
database.unlink = function unlink(ctx, name, callback) {
  var opctx = {
    dbctx:ctx,
    name:name
  };
  var hdl = makeHandle(opctx, callback);
  Object.defineProperty(ctx, 'run', { value:database.unlink.run.bind(hdl, opctx) });
  process.nextTick(ctx.run);
  return hdl;
};
database.unlink.run = function (ctx) {
  var op = retry();
  op.attempt(function(attempt) {
    ctx.connect(function(err, db) {
      if (retry.retry(err)) return ctx.dbctx.emit('debug', err);
      err = retry.mainError();
      if (err) {
        ctx.dbctx.emit('error', err);
        ctx.complete(err);
        return;
      }
      mongodb.GridStore.unlink(db, ctx.name, function(err) {
        if (retry.retry(err)) return ctx.dbctx.emit('debug', err);
        ctx.complete(retry.mainError());
      });
    });
  });
};

function cursor(coll, retime, query, fields) {
  var ctx = {
    collection:coll,
    retime:retime,
    cursor:db.find(query, fields)
  };
  var obj = {};
  Object.defineProperty(obj, 'skip', { value:ctx.cursor.skip.bind(ctx.cursor) });
  Object.defineProperty(obj, 'limit', { value:ctx.cursor.limit.bind(ctx.cursor) });
  Object.defineProperty(obj, 'sort', { value:ctx.cursor.sort.bind(ctx.cursor) });

  Object.defineProperty(obj, 'nextObject', { value:cursor.proxy.bind(obj, ctx, ctx.cursor.nextObject) });
  Object.defineProperty(obj, 'next', { value:obj.next });
  Object.defineProperty(obj, 'rewind', { value:cursor.proxy.bind(obj, ctx, ctx.cursor.rewind) });
  Object.defineProperty(obj, 'toArray', { value:cursor.proxy.bind(obj, ctx, ctx.cursor.toArray) });
  Object.defineProperty(obj, 'array', { value:obj.array });
  Object.defineProperty(obj, 'each', { value:cursor.proxy.bind(obj, ctx, ctx.cursor.each) });

  return obj;
}
cursor.proxy = function proxy(ctx, fn) {
  ctx.retime();
  return fn.apply(ctx.cursor, Array.prototype.slice.call(arguments, 2));
};

function WriteStream(store, retime) {
  var ctx = { store:store, retime:retime, writable:true, emitter:new EventEmitter() };
  var obj = {};

  Object.defineProperty(obj, 'writable', { get:WriteStream.writable.bind(obj, ctx) });
  Object.defineProperty(obj, 'write', { value:WriteStream.write.bind(obj, ctx) });
  Object.defineProperty(obj, 'end', { value:WriteStream.end.bind(obj, ctx) });
  Object.defineProperty(obj, 'close', { value:WriteStream.close.bind(obj, ctx) });
  Object.defineProperty(obj, 'destroy', { value:obj.close });
  Object.defineProperty(obj, 'destroySoon', { value:WriteStream.destroySoon.bind(obj, ctx) });
  Object.defineProperty(obj, 'on', { value:ctx.emitter.on.bind(ctx.emitter) });
  Object.defineProperty(ctx, 'emit', { value:ctx.emitter.emit.bind(ctx.emitter) });

  return obj;
}
WriteStream.writable = function writable(ctx) {
  return ctx.writable;
};
WriteStream.write = function write(ctx, data, encoding) {
  data = Buffer.isBuffer(data) ? data : new Buffer(data,encoding);
  ctx.retime();
  ctx.store.write(data, function(err) {
    if (err) return ctx.emit('error', err);
    ctx.emit('drain');
  });
  return false;
};
WriteStream.end = function end(ctx, data, encoding) {
  if (data) {
    this.write(data, encoding);
    this.once('drain', this.close);
  } else {
    this.close();
  }
};
WriteStream.close = function close(ctx) {
  ctx.retime();
  ctx.emit('end');
  ctx.writable=false;
  ctx.store.close(function(err) {
    if (err) return ctx.emit('error', err);
    ctx.emit('close');
  });
};
WriteStream.destroySoon = function destroySoon(ctx) {
  // Who ever calls this?
  ctx.retime();
};

function makeHandle(ctx, callback) {
  var handle = { done:[], fail:[], always:[], emitter:new EventEmitter() };
  var obj = {};
  Object.defineProperty(obj, 'done', { value:makeHandle.register.bind(obj, ctx, handle.done ) });
  Object.defineProperty(obj, 'fail', { value:makeHandle.register.bind(obj, ctx, handle.fail ) });
  Object.defineProperty(obj, 'always', { value:makeHandle.register.bind(obj, ctx, handle.always ) });
  Object.defineProperty(obj, 'on', { value:ctx.emitter.on.bind(ctx.emitter) });
  Object.defineProperty(ctx, 'emit', { value:ctx.emitter.emit.bind(ctx.emitter) });
  Object.defineProperty(ctx, 'complete', { value:makeHandle.complete.bind(obj, ctx, handle) });
  return obj.always(callback);
}
makeHandle.register = function register(ctx, store, callback) {
  if ('function' === typeof callback) {
    store.push(callback);
  }
  return this;
};
makeHandle.complete = function complete(ctx, handle, err) {
  var db = this;
  var args = Array.prototype.slice.call(arguments, 2);
  if (err) {
    handle.fail.forEach(function(fn) {
      fn.apply(db, args);
    });
  } else {
    handle.done.forEach(function(fn) {
      fn.apply(db, args.slice(1));
    });
  }
  handle.always.forEach(function(fn) {
    fn.apply(db, args);
  });
};