/*
** © 2012 by YOUSURE Tarifvergleich GmbH. Licensed under MIT License
*/

module.exports = database;

var mongo = require('mongodb');
var EventEmitter = require('events').EventEmitter;
var retry = require('retry').operation;
//var domain=require('domain').create;
var retrySettings={ retries:3, factor:1, minTimeout:1000 };

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
  return new mongo.Server(def.host, def.port, opts);
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
    def = new mongo.ReplSetServers(def.servers, { rs_name:def.replset });
  } else {
    def.port = def.port || 27017;
    if (!def.host || isNaN(def.port)) throw new Error('Invalid Database Definition (bad servers)');
    def.options = def.options || { auto_reconnect:true };
    def = makeServer(def, def.options);
  }
  return def;
}
function database(def, name) {
  var ctx = {
    name:String(name),
    timeout:(def.timeout || 60) * 1000,
    user:def.username,
    pass:def.password,
    emitter:new EventEmitter()
  };

  var obj = {};

  Object.defineProperty(ctx, 'define', { value:database.define.bind(obj, ctx, def) });
  Object.defineProperty(ctx, 'retime', { value:database.retime.bind(obj, ctx) });
  Object.defineProperty(ctx, 'open', { value:database.open.bind(obj, ctx) });
  Object.defineProperty(ctx, 'auth', { value:database.auth.bind(obj, ctx) });
  Object.defineProperty(ctx, 'connect', { value:database.connect.bind(obj, ctx) });
  Object.defineProperty(ctx, 'close', { value:database.close.bind(obj, ctx) });
  Object.defineProperty(ctx, 'emit', { value:ctx.emitter.emit.bind(ctx.emitter) });

  Object.defineProperty(obj, 'name', { value:ctx.name });
  Object.defineProperty(obj, 'find', { value:database.find.bind(obj, ctx) });
  Object.defineProperty(obj, 'aggregate', { value:database.aggregate.bind(obj, ctx) });
  Object.defineProperty(obj, 'update', { value:database.update.bind(obj, ctx) });
  Object.defineProperty(obj, 'upsert', { value:database.upsert.bind(obj, ctx) });
  Object.defineProperty(obj, 'insert', { value:database.insert.bind(obj, ctx) });
  Object.defineProperty(obj, 'remove', { value:database.remove.bind(obj, ctx) });
  Object.defineProperty(obj, 'file', { value:database.file.bind(obj, ctx) });
  Object.defineProperty(obj, 'unlink', { value:database.unlink.bind(obj, ctx) });
  Object.defineProperty(obj, 'group', { value:database.group.bind(obj, ctx) });
  Object.defineProperty(obj, 'on', { value:ctx.emitter.on.bind(ctx.emitter) });

  return obj;
}
database.define = function define(ctx, def) {
  return ctx.srv = makeDefinition(JSON.parse(JSON.stringify(def)));
};
database.retime = function retime(ctx) {
  if (!ctx.db) return;
  clearTimeout(ctx.db.mstimer);
  ctx.db.mstimer=setTimeout(ctx.db.close.bind(ctx.db), ctx.timeout);
};
database.open = function open(ctx, callback) {
  if (ctx.db) {
    ctx.retime();
    return callback(undefined, ctx.db);
  }
  if (ctx.opening) {
    return setTimeout(ctx.open.bind(ctx, callback), 500);
  }
  ctx.opening = true;
  var op = retry({ retries:5, factor:1.5, minTimeout:2500 });
  op.attempt(function(attempt) {
    //console.log('DB-OPEN ',attempt);
    var db = mongo.Db(ctx.name, ctx.define(), {});

    db.open(function(err, db) {
      //if (err) { console.error(err.stack); } else { console.error('OPENED'); }
      if (op.retry(err)) return ctx.emit('debug', err);
      err = op.mainError();
      ctx.opening=false;
      if (err) ctx.emit('error', err);
      if (db) ctx.retime();
      return callback(err, db);
    });
  });
};
database.auth = function auth(ctx, callback) {
  ctx.open(function opened(err, db) {
    if (err) return callback(err);
    if (!ctx.user || db.authenticated) return callback(undefined, db);
    var op = retry(retrySettings);
    op.attempt(function(attempt) {
      ctx.retime();
      db.authenticate(ctx.user, ctx.pass, function(err) {
        if (op.retry(err)) return ctx.emit('debug', err);
        err = op.mainError();
        if (!err) db.authenticated=true;
        if (err) ctx.emit('error', err);
        return callback(err, db);
      });
    });
  });
};
database.connect = function connect(ctx, callback) {
  ctx.auth(function(err, db) {
    if (err) ctx.emit('error', err);
    ctx.retime();
    return callback(err, ctx.db=db);
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
  Object.defineProperty(opctx, 'run', { value:database.find.run.bind(hdl, opctx) });
  process.nextTick(opctx.run);
  return hdl;
};
database.find.run = function run(ctx) {
  ctx.dbctx.connect(function(err, db) {
    if (err && ('need to login'===(err.message || String(err))) && ctx.dbctx.db) {
      ctx.dbctx.db.authenticated = false;
      return process.nextTick(ctx.run);
    }
    if (err) {
      ctx.dbctx.emit('error', err);
      ctx.complete(err);
      return;
    }
    var op = retry(retrySettings);
    op.attempt(function(attempt) {
      db.collection(ctx.collection, function(err, coll) {
        if (err && ('need to login'===(err.message || String(err))) && ctx.dbctx.db) {
          ctx.dbctx.db.authenticated = false;
          return process.nextTick(ctx.run);
        }
        if (op.retry(err)) return ctx.dbctx.emit('debug', err);
        err = op.mainError();
        if (err) {
          ctx.dbctx.emit('error', err);
          ctx.complete(err);
          return;
        }
        ctx.dbctx.retime();
        ctx.complete(undefined, cursor(coll, ctx.dbctx, ctx.query, ctx.fields));
      });
    });
  });
};
database.aggregate = function aggregate(ctx, collection, pipeline, callback) {
  var opctx = {
    dbctx:ctx,
    collection:collection,
    pipeline:pipeline
  };
  var hdl = makeHandle(opctx, callback);
  Object.defineProperty(opctx, 'run', { value:database.aggregate.run.bind(hdl, opctx) });
  process.nextTick(opctx.run);
  return hdl;
};
database.aggregate.run = function run(ctx) {
  ctx.dbctx.connect(function(err, db) {
    if (err && ('need to login'===(err.message || String(err))) && ctx.dbctx.db) {
      ctx.dbctx.db.authenticated = false;
      return process.nextTick(ctx.run);
    }
    if (err) {
      ctx.dbctx.emit('error', err);
      ctx.complete(err);
      return;
    }
    var op = retry(retrySettings);
    op.attempt(function(attempt) {
      db.collection(ctx.collection, function(err, coll) {
        if (err && ('need to login'===(err.message || String(err))) && ctx.dbctx.db) {
          ctx.dbctx.db.authenticated = false;
          return process.nextTick(ctx.run);
        }
        if (op.retry(err)) return ctx.dbctx.emit('debug', err);
        err = op.mainError();
        if (err) {
          ctx.dbctx.emit('error', err);
          ctx.complete(err);
          return;
        }
        ctx.dbctx.retime();
        coll.aggregate(ctx.pipeline, {}, ctx.complete.bind(ctx));
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
  Object.defineProperty(opctx, 'run', { value:database.update.run.bind(hdl, opctx) });
  process.nextTick(opctx.run);
  return hdl;
};
database.update.run = function run(ctx) {
  ctx.dbctx.connect(function(err, db) {
    if (err && ('need to login'===(err.message || String(err))) && ctx.dbctx.db) {
      ctx.dbctx.db.authenticated = false;
      return process.nextTick(ctx.run);
    }
    if (err) {
      ctx.dbctx.emit('error', err);
      ctx.complete(err);
      return;
    }
    var op = retry(retrySettings);
    op.attempt(function(attempt) {
      db.collection(ctx.collection, function(err, coll) {
        if (err && ('need to login'===(err.message || String(err))) && ctx.dbctx.db) {
          ctx.dbctx.db.authenticated = false;
          return process.nextTick(ctx.run);
        }
        if (op.retry(err)) return ctx.dbctx.emit('debug', err);
        err = op.mainError();
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
  Object.defineProperty(opctx, 'run', { value:database.upsert.run.bind(hdl, opctx) });
  process.nextTick(opctx.run);
  return hdl;
};
database.upsert.run = function run(ctx) {
  ctx.dbctx.connect(function(err, db) {
    if (err && ('need to login'===(err.message || String(err))) && ctx.dbctx.db) {
      ctx.dbctx.db.authenticated = false;
      return process.nextTick(ctx.run);
    }
    if (err) {
      ctx.dbctx.emit('error', err);
      ctx.complete(err);
      return;
    }
    var op = retry(retrySettings);
    op.attempt(function(attempt) {
      db.collection(ctx.collection, function(err, coll) {
        if (err && ('need to login'===(err.message || String(err))) && ctx.dbctx.db) {
          ctx.dbctx.db.authenticated = false;
          return process.nextTick(ctx.run);
        }
        if (op.retry(err)) return ctx.dbctx.emit('debug', err);
        err = op.mainError();
        if (err) {
          ctx.dbctx.emit('error', err);
          ctx.complete(err);
          return;
        }
        ctx.dbctx.retime();
        coll.update(ctx.query, ctx.document, { safe:true, multi:false, upsert:true }, function(err,val) {
          ctx.complete(err,val);
        });
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
  Object.defineProperty(opctx, 'run', { value:database.insert.run.bind(hdl, opctx) });
  process.nextTick(opctx.run);
  return hdl;
};
database.insert.run = function run(ctx) {
  ctx.dbctx.connect(function(err, db) {
    if (err && ('need to login'===(err.message || String(err))) && ctx.dbctx.db) {
      ctx.dbctx.db.authenticated = false;
      return process.nextTick(ctx.run);
    }
    if (err) {
      ctx.dbctx.emit('error', err);
      ctx.complete(err);
      return;
    }
    var op = retry(retrySettings);
    op.attempt(function(attempt) {
      db.collection(ctx.collection, function(err, coll) {
        if (err && ('need to login'===(err.message || String(err))) && ctx.dbctx.db) {
          ctx.dbctx.db.authenticated = false;
          return process.nextTick(ctx.run);
        }
        if (op.retry(err)) return ctx.dbctx.emit('debug', err);
        err = op.mainError();
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
  Object.defineProperty(opctx, 'run', { value:database.remove.run.bind(hdl, opctx) });
  process.nextTick(opctx.run);
  return hdl;
};
database.remove.run = function run(ctx) {
  ctx.dbctx.connect(function(err, db) {
    if (err && ('need to login'===(err.message || String(err))) && ctx.dbctx.db) {
      ctx.dbctx.db.authenticated = false;
      return process.nextTick(ctx.run);
    }
    if (err) {
      ctx.emit('error', err);
      ctx.complete(err);
      return;
    }
    var op = retry(retrySettings);
    op.attempt(function(attempt) {
      db.collection(ctx.collection, function(err, coll) {
        if (err && ('need to login'===(err.message || String(err))) && ctx.dbctx.db) {
          ctx.dbctx.db.authenticated = false;
          return process.nextTick(ctx.run);
        }
        if (op.retry(err)) return ctx.dbctx.emit('debug', err);
        err = op.mainError();
        if (err) {
          ctx.dbctx.emit('error', err);
          ctx.complete(err);
          return;
        }
        ctx.dbctx.retime();
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
  Object.defineProperty(opctx, 'run', { value:database.file.run.bind(hdl, opctx) });
  process.nextTick(opctx.run);
  return hdl;
};
database.file.run = function run(ctx) {
  var gshdl = this;
  ctx.dbctx.connect(function(err, db) {
    if (err && ('need to login'===(err.message || String(err))) && ctx.dbctx.db) {
      ctx.dbctx.db.authenticated = false;
      return process.nextTick(ctx.run);
    }
    if (err) {
      ctx.dbctx.emit('error', err);
      ctx.complete(err);
      return;
    }
    var op = retry(retrySettings);
    op.attempt(function(attempt) {
      var store = new mongo.GridStore(db, ctx.name, ctx.mode, ctx.meta);
      store.open(function (err, store) {
        if (err && ('need to login'===(err.message || String(err))) && ctx.dbctx.db) {
          ctx.dbctx.db.authenticated = false;
          return process.nextTick(ctx.run);
        }
        if (op.retry(err)) return ctx.dbctx.emit('debug', err);
        err = op.mainError();
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
  return stream;
};
database.unlink = function unlink(ctx, name, callback) {
  var opctx = {
    dbctx:ctx,
    name:name
  };
  var hdl = makeHandle(opctx, callback);
  Object.defineProperty(opctx, 'run', { value:database.unlink.run.bind(hdl, opctx) });
  process.nextTick(opctx.run);
  return hdl;
};
database.unlink.run = function (ctx) {
  ctx.connect(function(err, db) {
    if (err && ('need to login'===(err.message || String(err))) && ctx.dbctx.db) {
      ctx.dbctx.db.authenticated = false;
      return process.nextTick(ctx.run);
    }
    if (err) {
      ctx.dbctx.emit('error', err);
      ctx.complete(err);
      return;
    }
    var op = retry(retrySettings);
    op.attempt(function(attempt) {
      mongodb.GridStore.unlink(db, ctx.name, function(err) {
        if (err && ('need to login'===(err.message || String(err))) && ctx.dbctx.db) {
          ctx.dbctx.db.authenticated = false;
          return process.nextTick(ctx.run);
        }
        if (op.retry(err)) return ctx.dbctx.emit('debug', err);
        ctx.complete(op.mainError());
      });
    });
  });
};
database.group = function group(ctx, name, keys, condition, reduce, finalize, callback) {
  var opctx = {
    dbctx:ctx,
    name:name,
    keys:keys,
    cond:condition,
    reduce:reduce,
    finalize:finalize
  };

  var hdl = makeHandle(opctx, callback);
  Object.defineProperty(opctx, 'run', { value:database.group.run.bind(hdl, opctx) });
  process.nextTick(opctx.run);
  return hdl;
};
database.group.run = function run(ctx) {
  ctx.dbctx.connect(function(err, db) {
    if (err && ('need to login'===(err.message || String(err))) && ctx.dbctx.db) {
      ctx.dbctx.db.authenticated = false;
      return process.nextTick(ctx.run);
    }
    if (err) {
      ctx.dbctx.emit('error', err);
      ctx.complete(err);
      return;
    }
    var op = retry();
    op.attempt(function(attempt) {
      db.collection(ctx.name, function(err, coll) {
        if (err && ('need to login'===(err.message || String(err))) && ctx.dbctx.db) {
          ctx.dbctx.db.authenticated = false;
          return process.nextTick(ctx.run);
        }
        if (op.retry(err)) return ctx.dbctx.emit('debug', err);
        err = op.mainError();
        if (err) {
          ctx.dbctx.emit('error', err);
          ctx.complete(err);
          return;
        }
        ctx.dbctx.retime();
        coll.group(ctx.keys, ctx.cond, {}, ctx.reduce, ctx.finalize, true, { safe:true }, ctx.complete);
      });
    });
  });
};

function cursor(coll, dbctx, query, fields) {
  var ctx = {
    collection:coll,
    retime:dbctx.retime
  };
  ctx.cursor = fields ? coll.find(query, fields) : coll.find(query);
  var obj = {};
  Object.defineProperty(obj, 'count', { value:cursor.proxySelf.bind(obj, ctx, ctx.cursor.count) });
  Object.defineProperty(obj, 'skip', { value:cursor.proxySelf.bind(obj, ctx, ctx.cursor.skip) });
  Object.defineProperty(obj, 'limit', { value:cursor.proxySelf.bind(obj, ctx, ctx.cursor.limit) });
  Object.defineProperty(obj, 'sort', { value:cursor.proxySelf.bind(obj, ctx, ctx.cursor.sort) });

  Object.defineProperty(obj, 'nextObject', { value:cursor.proxy.bind(obj, ctx, ctx.cursor.nextObject) });
  Object.defineProperty(obj, 'next', { value:obj.nextObject });
  Object.defineProperty(obj, 'rewind', { value:cursor.proxy.bind(obj, ctx, ctx.cursor.rewind) });
  Object.defineProperty(obj, 'toArray', { value:cursor.proxy.bind(obj, ctx, ctx.cursor.toArray) });
  Object.defineProperty(obj, 'array', { value:obj.toArray });
  Object.defineProperty(obj, 'each', { value:cursor.proxy.bind(obj, ctx, ctx.cursor.each) });

  return obj;
}
cursor.proxy = function proxy(ctx, fn) {
  ctx.retime();
  return fn.apply(ctx.cursor, Array.prototype.slice.call(arguments, 2));
};
cursor.proxySelf = function proxy(ctx, fn) {
  ctx.retime();
  fn.apply(ctx.cursor, Array.prototype.slice.call(arguments, 2));
  return this;
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
  Object.defineProperty(obj, 'emit', { value:ctx.emitter.emit.bind(ctx.emitter) });
  Object.defineProperty(obj, 'removeListener', { value:ctx.emitter.removeListener.bind(ctx.emitter) });
  Object.defineProperty(obj, 'removeAllListeners', { value:ctx.emitter.removeAllListeners.bind(ctx.emitter) });
  Object.defineProperty(obj, 'addListener', { value:ctx.emitter.addListener.bind(ctx.emitter) });
  Object.defineProperty(obj, 'listeners', { value:ctx.emitter.listeners.bind(ctx.emitter) });
  Object.defineProperty(obj, 'setMaxListeners', { value:ctx.emitter.setMaxListeners.bind(ctx.emitter) });
  Object.defineProperty(obj, 'once', { value:ctx.emitter.once.bind(ctx.emitter) });
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
    if (err) {
      return ctx.emit('error', err);
    }
  });
  return true;
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
  var handle = { done:[], fail:[], always:[], emitter: new EventEmitter() };
  var obj = {};
  Object.defineProperty(obj, 'done', { value:makeHandle.register.bind(obj, ctx, handle.done ) });
  Object.defineProperty(obj, 'fail', { value:makeHandle.register.bind(obj, ctx, handle.fail ) });
  Object.defineProperty(obj, 'always', { value:makeHandle.register.bind(obj, ctx, handle.always ) });
  Object.defineProperty(obj, 'on', { value:handle.emitter.on.bind(ctx.emitter) });
  Object.defineProperty(ctx, 'emit', { value:handle.emitter.emit.bind(ctx.emitter) });
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
