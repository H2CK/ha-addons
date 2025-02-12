#!/usr/bin/env node
const fs = require('fs');
const ldap = require('ldapjs');
const yargs = require('yargs');
var nconf = require('nconf');
const ssha = require('./lib/ssha');
const outputGenerator = require('./lib/output-generator');
var imaps = require('@klenty/imap');

var initialLoaded = false;
var dataUpdated = false;
var customData = {};

const argv = yargs
  .option('c', {
    default: './config.json',
    description: 'The config file to use',
    alias: 'config',
    type: 'string'
  })
  .option('v', {
    default: false,
    description: 'Generate more detailed output',
    alias: 'verbose',
    type: 'boolean'
  })
  .help()
  .alias('help', 'h').argv;

nconf.argv().env();
nconf.file( 'common', argv.c );

nconf.defaults({
    'baseDn': 'dc=example,dc=com',
    'userDn': 'ou=people,dc=example,dc=com',
    'groupDn': 'ou=groups,dc=example,dc=com',
    'organization': 'EXAMPLE INC.',
    'domain': 'example',
    'bindDn': 'cn=admin,dc=example,dc=com',
    'bindPassword': '123456',
    'port': 389,
    'securePort': 636,
    'hostname': '0.0.0.0',
    'dataFile': './data/data.json',
    'salt': '2A6F5B3C',
    'cacheTimeout': 21600000,
    'imap': {
      'hostname': 'localhost',
      'port': 143,
      'useTLS': false
    }
});

outputGenerator.init(nconf, argv.v);

initialLoad((err) => {
  if (err) {
    console.log('Error: Stopping process...');
    process.exit();
  }
});

const intervalObj = setInterval(saveData, 10000);

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

///--- Graceful shutdown

process.stdin.resume();

function exitHandler(options, exitCode) {
    if (options.cleanup) {
      console.log('Cleanup actions...');
      clearInterval(intervalObj);
      saveData();
      // await sleep(3000);
    }
    if (exitCode || exitCode === 0) console.log('ExitCode: ', exitCode);
    if (options.exit) process.exit();
}

//do something when app is closing
process.on('exit', exitHandler.bind(null,{cleanup:true}));

//catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, {exit:true}));

// catches "kill pid" (for example: nodemon restart)
process.on('SIGUSR1', exitHandler.bind(null, {exit:true}));
process.on('SIGUSR2', exitHandler.bind(null, {exit:true}));

//catches uncaught exceptions
process.on('uncaughtException', exitHandler.bind(null, {exit:true}));

///--- Shared handlers

function authorize(req, res, next) {
  const bindDn = ldap.parseDN(nconf.get('bindDn'));
  if (!req.connection.ldap.bindDN.equals(bindDn))
    return next(new ldap.InsufficientAccessRightsError());

  return next();
}

function initialLoad(next) {
  console.log('Initial loading of data from %s', nconf.get('dataFile'))
  fs.readFile(nconf.get('dataFile'), 'utf8', (err, data) => {
    if (err) {
      console.log('Error: Reading user data failed.');
      return next(new ldap.OperationsError(err.message));
    }

    customData = {
      "users": [],
      "groups": []
    };

    try {
      var rawData = JSON.parse(data);
      customData.users = rawData.users || [];
      customData.groups = rawData.groups || [];
    } catch(err1) {
      console.log('Error: Parsing data file failed: ', err1);
      return next(err1);
    }
    initialLoaded = true;
    updateMemberOf();
    return next();
  });
}

function loadData(req, res, next) {
  if (!initialLoaded) {
    initialLoad((err) => {
      if (err) {
        console.log('Error: Reading user data failed.');
        return next(new ldap.OperationsError(err.message));
      }
      req.customData = customData;
      return next();
    });
  } else {
    req.customData = customData;
  }
  return next();
}

function storeData(data) {
  customData = data;
  updateMemberOf();
  dataUpdated = true;
}

function saveData() {
  if (dataUpdated) {
    var customDataCache = JSON.parse(JSON.stringify(customData));
    const keys = Object.keys(customDataCache.users);
    for (const k of keys) {
      if (customDataCache.users[k].attributes.memberOf)
        delete customDataCache.users[k].attributes.memberOf;
    }

    const jsonData = JSON.stringify(customDataCache);
    fs.writeFile(nconf.get('dataFile'), jsonData, (err) => {
      if (err) {
        console.log('Error: Writing data file failed: ', err);
      } else {
        dataUpdated = false;
        console.log('Wrote data to file.');
      }
    });
  }
}

function updateMemberOf() {
  for (const j of Object.keys(customData.users)) {
    var memberOf = [];
    for (const k of Object.keys(customData.groups)) {
      const uniqueMemberKeys = Object.keys(customData.groups[k].attributes.uniqueMember || []);
      for (const i of uniqueMemberKeys) {
        const dnObj = ldap.parseDN(customData.users[j].dn);
        if (dnObj.equals(customData.groups[k].attributes.uniqueMember[i])) {
          memberOf.push(customData.groups[k].dn);
        }
      }
    }
    customData.users[j].attributes.memberOf = memberOf;
  }
}

function existsObject(objects, dn) {
  const keys = Object.keys(objects);
  for (const k of keys) {
    if (dn.equals(objects[k].dn)) 
      return true;
  }
  return false;
}

function removeObject(objects, dn) {
  const keys = Object.keys(objects);
  var localObjs = [];
  for (const k of keys) {
    if (!dn.equals(objects[k].dn)) 
      localObjs.push(objects[k]);
  }
  return localObjs;
}

function addAttributeObject(objects, dn, attribute, value) {
  const keys = Object.keys(objects);
  var localObjs = objects;
  for (const k of keys) {
    if (dn.equals(objects[k].dn)) 
      localObjs[k].attributes[attribute].push(value[0]);
  }
  return localObjs;
}

function replaceAttributeObject(objects, dn, attribute, value) {
  const keys = Object.keys(objects);
  var localObjs = objects;
  for (const k of keys) {
    if (dn.equals(objects[k].dn)) 
      localObjs[k].attributes[attribute] = value;
  }
  return localObjs;
}

function deleteAttributeObject(objects, dn, attribute, value) {
  const keys = Object.keys(objects);
  var localObjs = objects;
  for (const k of keys) {
    if (dn.equals(objects[k].dn)) {
      var valueArray = [];
      const ikeys = Object.keys(localObjs[k].attributes[attribute]);
      for (const i of ikeys) {
        if (localObjs[k].attributes[attribute][i] !== value[0]) {
          valueArray.push(localObjs[k].attributes[attribute][i]);
        }
        
      }
      localObjs[k].attributes[attribute] = valueArray;
    }
  }
  return localObjs;
}

function getUser(dn) {
  for (const k of Object.keys(customData.users)) {
    if (dn.equals(customData.users[k].dn)) {
      return customData.users[k]
    }
  }
  return null;
}

function checkValidCache(dn) {
  const user = getUser(dn);
  if (argv.v) console.debug('Cache check - lastUpdateTimestamp:%s cacheTimeout:%s timestampNow:%s', Date.parse(user.attributes.lastPasswordUpdate), nconf.get('cacheTimeout'), Date.now());
  if (user && 
      user.attributes.lastPasswordUpdate && 
      Date.parse(user.attributes.lastPasswordUpdate) + nconf.get('cacheTimeout') > Date.now())
        return true;
  return false;
}

function updatePassword(dn, password, next) {
  const keys = Object.keys(customData.users);
  for (const k of keys) {
    if (dn.equals(customData.users[k].dn)) {
      customData.users[k].attributes.lastPasswordUpdate = new Date().toISOString();
      var bhash = new Buffer.from(nconf.get('salt').substr(6),'base64');
      var salt = bhash.toString('binary',20);
      ssha.ssha_pass(password, salt, function(err, hashedPassword) {
        if (err) {
          console.log('Password hashing for %s failed: %s ',dn.toString(), err);
          return next(new ldap.InvalidCredentialsError());
        } else {
          console.log('Updated password for %s', dn.toString());
          customData.users[k].attributes.userPassword = [ hashedPassword ];
          dataUpdated = true;
          return next(null);
        }
      }); 
    }
  }
}

function imapAuthentication(dn, password, next) {
  const user = getUser(dn);
  if (!user)
    return next(new ldap.NoSuchObjectError(dn.toString()));
  
  var config = {
    imap: {
        user: user.attributes.mail[0],
        password: password,
        host: nconf.get('imap:hostname'),
        port: nconf.get('imap:port'),
        tls: nconf.get('imap:useTLS'),
        authTimeout: 3000
    }
  };

  imaps.connect(config).then((connection) => {
    console.log('Connected to IMAP server for %s with address %s', dn.toString(), user.attributes.mail[0]);
    connection.end();
    updatePassword(dn, password, (errUpdatePassword) => {
      if (errUpdatePassword) return next(new ldap.InvalidCredentialsError());
      return next(null, true);
    });
  }).catch((reason) => {
    console.log('Connecting to IMAP server failed for %s with address %s: %s', dn.toString(), user.attributes.mail[0], reason.toString());
    return next(new ldap.InvalidCredentialsError());
  });
}

const pre = [authorize, loadData];

///--- Mainline

const server = ldap.createServer();

server.bind(nconf.get('baseDn'), loadData, (req, res, next) => {
  console.log('BIND dn: %s', req.dn.toString());
  const bindDn = ldap.parseDN(nconf.get('bindDn'));
  if (req.dn.equals(bindDn)) {
    if (req.credentials !== nconf.get('bindPassword')) {
      console.log('BIND dn: %s failed',req.dn.toString());
      return next(new ldap.InvalidCredentialsError());
    } else {
      res.end();
      console.log('BIND dn: %s successful',req.dn.toString());
      return next();
    }
  } else if (req.dn.childOf(nconf.get('userDn'))) {
    if (checkValidCache(req.dn)) {
      console.log('Cache valid: Verify password against cache for %s', req.dn.toString());
      const user = getUser(req.dn);
      ssha.checkssha(req.credentials, user.attributes.userPassword[0], function(err, authenticated) {
        if (err || !authenticated) {
          console.log('Password check against cache failed for %s',req.dn.toString());
          imapAuthentication(req.dn, req.credentials, (err1, authenticated1) => {
            if (err1) {
              console.log('BIND dn: %s failed. Error: %s',req.dn.toString(), err1.message);
              return next(err1);
            }
            if (!authenticated1) {
              res.end();
              console.log('BIND dn: %s successful.',req.dn.toString());
              return next();
            } else {
              console.log('BIND dn: %s failed.',req.dn.toString());
              return next(new ldap.InvalidCredentialsError());
            }
          });
        } else {
          res.end();
          console.log('BIND dn: %s successful',req.dn.toString());
          return next();
        }
      }); 
    } else {
      console.log('Cache invalid: Verify password against imap for %s', req.dn.toString());
      imapAuthentication(req.dn, req.credentials, (err2, authenticated2) => {
        if (err2) {
          console.log('BIND dn: %s failed. Error: %s',req.dn.toString(), err2.message);
          return next(err2);
        }
        if (authenticated2) {
          res.end();
          console.log('BIND dn: %s successful.',req.dn.toString());
          return next();
        } else {
          console.log('BIND dn: %s failed.',req.dn.toString());
          return next(new ldap.InvalidCredentialsError());
        }
      });
    }
  } else {
    console.log('BIND dn: %s failed. Error: Invalid dn',req.dn.toString());
    return next(new ldap.InvalidCredentialsError());
  }
});


server.add(nconf.get('baseDn'), pre, (req, res, next) => {
  console.log('ADD dn: %s', req.dn.toString());

  const userTemplate = {
    dn: req.dn.toString(),
    attributes: {
    }
  }

  const groupTemplate = {
    dn: req.dn.toString(),
    attributes: {
    }
  }

  const entry = req.toObject().attributes;
  if (!entry.cn)
      return next(new ldap.ConstraintViolationError('Error: cn required'));
  
  if (req.dn.childOf(nconf.get('userDn'))) {
    if (existsObject(req.customData.users, req.dn))
      return next(new ldap.EntryAlreadyExistsError(req.dn.toString()));

    userTemplate.attributes = entry;
    req.customData.users.push(userTemplate);
    storeData(req.customData);
  } else if (req.dn.childOf(nconf.get('groupDn'))) {
    if (existsObject(req.customData.groups, req.dn))
      return next(new ldap.EntryAlreadyExistsError(req.dn.toString()));

    req.customData.groups.push(groupTemplate);
    storeData(req.customData);
  } else {
    return next(new ldap.UnwillingToPerformError('only adding of groups and users allowed'));
  }

  res.end();
  return next();
});


server.modify(nconf.get('baseDn'), pre, (req, res, next) => {
  console.log('MODIFY dn: %s', req.dn.toString());

  if (!req.changes.length)
    return next(new ldap.ProtocolError('changes required'));

  if (req.dn.childOf(nconf.get('userDn'))) {
    if (!existsObject(req.customData.users, req.dn))
      return next(new ldap.NoSuchObjectError(req.dn.toString()));

    let mod;
    for (const change of req.changes) {
      mod = change.modification;
      console.log('Change %s for %s', change.operation, mod.type);
      switch (change.operation) {
        case 'replace':
          if (mod.type == 'userpassword') {
            return next(new ldap.UnwillingToPerformError('Change of password is currently not allowed'));
          }
          req.customData.users = replaceAttributeObject(req.customData.users, req.dn, mod.type, mod.vals);
          storeData(req.customData);
          break;
        case 'add':
          if (mod.type == 'userpassword') {
            return next(new ldap.UnwillingToPerformError('Change of password is currently not allowed'));
          }
          req.customData.users = addAttributeObject(req.customData.users, req.dn, mod.type, mod.vals);
          storeData(req.customData);
          break;
        case 'delete':
          if (mod.type == 'userpassword') {
            return next(new ldap.UnwillingToPerformError('Change of password is currently not allowed'));
          }
          req.customData.users = deleteAttributeObject(req.customData.users, req.dn, mod.type, mod.vals);
          storeData(req.customData);
          break;
      }
    }
  } else if (req.dn.childOf(nconf.get('groupDn'))) {
    if (!existsObject(req.customData.groups, req.dn))
      return next(new ldap.NoSuchObjectError(req.dn.toString()));

    let mod;
    for (const change of req.changes) {
      mod = change.modification;
      console.log('Change %s for %s', change.operation, mod.type);
      switch (change.operation) {
        case 'replace':
          req.customData.groups = replaceAttributeObject(req.customData.groups, req.dn, mod.type, mod.vals);
          storeData(req.customData);
          break;
        case 'add':
          req.customData.groups = addAttributeObject(req.customData.groups, req.dn, mod.type, mod.vals);
          storeData(req.customData);
          break;
        case 'delete':
          req.customData.groups = deleteAttributeObject(req.customData.groups, req.dn, mod.type, mod.vals);
          storeData(req.customData);
          break;
      }
    }
  } else {
    return next(new ldap.UnwillingToPerformError('only deleting of groups and users allowed'));
  }
  
  res.end();
  return next();
});


server.del(nconf.get('baseDn'), pre, (req, res, next) => {
  console.log('DEL dn: %s', req.dn.toString());

  if (req.dn.childOf(nconf.get('userDn'))) {
    if (!existsObject(req.customData.users, req.dn))
      return next(new ldap.NoSuchObjectError(req.dn.toString()));

    req.customData.users = removeObject(req.customData.users, req.dn);
    storeData(req.customData);
  } else if (req.dn.childOf(nconf.get('groupDn'))) {
    if (!existsObject(req.customData.groups, req.dn))
      return next(new ldap.NoSuchObjectError(req.dn.toString()));

    req.customData.groups = removeObject(req.customData.groups, req.dn);
    storeData(req.customData);
  } else {
    return next(new ldap.UnwillingToPerformError('only deleting of groups and users allowed'));
  }

  res.end();
  return next();
});

server.search(nconf.get('baseDn'), pre, (req, res, next) => {
  console.log('SEARCH dn: %s scope: %s filter: %s', req.dn.toString(), req.scope, req.filter.toString());
  
  switch (req.scope) {
    case 'base':
      if (req.dn.equals(nconf.get('baseDn'))) {
        outputGenerator.sendBase(req, res);
      } else if (req.dn.equals(nconf.get('userDn'))) {
        outputGenerator.sendUsersBase(req, res);
      } else if (req.dn.equals(nconf.get('groupDn'))) {
        outputGenerator.sendGroupBase(req, res);
      } else if (req.dn.childOf(nconf.get('userDn'))) {
        outputGenerator.sendUser(req, res);
      } else if (req.dn.childOf(nconf.get('groupDn'))) {
        outputGenerator.sendGroup(req, res);
      } else {
        return next(new ldap.NoSuchObjectError(req.dn.toString()));
      }
      break;

    case 'one':
      if (req.dn.equals(nconf.get('baseDn'))) {
        outputGenerator.sendUsersBase(req, res);
        outputGenerator.sendGroupBase(req, res);
      } else if (req.dn.equals(nconf.get('userDn'))) {
        outputGenerator.sendUsers(req, res);
      } else if (req.dn.equals(nconf.get('groupDn'))) {
        outputGenerator.sendGroups(req, res);
      } else if (!(req.dn.childOf(nconf.get('userDn')) || req.dn.childOf(nconf.get('groupDn')))) {
        return next(new ldap.NoSuchObjectError(req.dn.toString()));
      }
      break;

    case 'sub':
      if (req.dn.equals(nconf.get('baseDn'))) {
        outputGenerator.sendUsersBase(req, res);
        outputGenerator.sendGroupBase(req, res);
        outputGenerator.sendUsers(req, res);
        outputGenerator.sendGroups(req, res);
      } else if (req.dn.equals(nconf.get('userDn'))) {
        outputGenerator.sendUsers(req, res);
      } else if (req.dn.equals(nconf.get('groupDn'))) {
        outputGenerator.sendGroups(req, res);
      } else if (!(req.dn.childOf(nconf.get('userDn')) || req.dn.childOf(nconf.get('groupDn')))) {
        return next(new ldap.NoSuchObjectError(req.dn.toString()));
      }
      break;
    
    default:
      return next(new ldap.UnwillingToPerformError('Error: Scope not allowed: ' + req.scope));
  }

  res.end();
  return next();
});

server.listen(nconf.get('port'), nconf.get('hostname'), () => {
  console.log('LDAP server up at: %s', server.url);
  if (argv.v) console.debug('Running in verbose mode.');
});
