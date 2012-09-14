# Mongo Simple

## Status

This module is currently being tested. There is likely so many bugs, that it's not even funny.

**DO NOT USE THIS ANYWHERE NEAR PRODUCTION!**

You have been warned!

## Install

    npm install mongo-simple

## Usage

### Opening a database

    var simple = require('mongo-simple');
    var database = simple(serverDefinition, name);

The server definition can take the following values:

 * *username* - Authentication User (optional)
 * *password* - Authentication Password (only with *username*)
 * *timeout* - Seconds to keep the Connection Open (default: 30)
 * *options* - an options object for the connection [see mongodb-native](https://github.com/mongodb/node-mongodb-native) (default: { auto_reconnect:true })

if you are connecting to a single server:

 * *host* - The hostname/ip of your mongo server
 * *port* - The port of your mongo server (default: 27017)

if you are connecting to a replication set:

 * *replset* - The name of the replication set
 * *servers* - An array of server definitions

a server definition is either a string in the format:

    <host>[:<port>]

or an object with the following properties:

 * *host* - The hostname/ip of your mongo server
 * *port* - The port of your mongo server (default: 27017)

### The *database* object

**Properties**

 * *name* - This reflects the database name you specified when opening the database.

Since Mongo-Simple intended to be simple, it takes care of the entire connection management for you. There are all the usual suspects in terms of operations. There are 2 fundamental ways to interact with the API.

 * The jQuery way: calling a function and the either *done()* or *fail()* or *always()* on the return value
 * The NodeJS way: calling a function with a callback that takes an *error* as its first argument

Basically these are equivalent:

    database.find(collenction, query, fields, function(err, cursor) { … });
    database.find(collenction, query, fields).always(function(err, cursor) { … });

alternatively you could do:

    database.find(collenction, query, fields).fail(function(err) { … }).done(function(cursor) { … });

#### Basic Methods

 * database.find(collection, query, fields[, callback]) // options are set as { safe:true }
 * database.update(collection, query, document[, callback]) // options are set as { safe:true, multi:true }
 * database.upsert(collection, query, document[, callback]) // options are set as { safe:true, multi:false, upsert:true }
 * database.insert(collection, document[, callback]) // options are set as { safe:true }
 * database.remove(collection, query[, callback]) // options are set as { safe:true }

These work the same way as their [mongodb-native](https://github.com/mongodb/node-mongodb-native) equivalents, except that you cannot specify options. Mongo-Simple takes care of those for you.

#### Grid-Store

##### Access

You can access gridstore files using

 * database.file(name, props[, callback])

If *props* is set, it is assumed that you want to write a file, because there are no properties you could pass to a file you want to read.

*props* is an object that can take the following properties:

 * *content_type* - The mime-type of the file
 * *metadata* - an object with meta-data (optional)
 * *chunk_size* - the size of chunks in the db (default:1024)

the *callback* (or *done* and *always* methods) gets a file object with these properties:

 * *size* - Size in bytes (only if opening for reading)
 * *content-type* - the mime-type of the file
 * *metadata* - the metadata object you specified when creating the file
 * *created* - the creation time of the file

in addition the object has a *stream()* method, which returns either a *ReadableStream* or a *WritableStream* depending on how you asked for the file.

##### Deleting

You can delete Grid-Store files using

 * database.unlink(name[, callback])







