# LDAP-IMAP-Bridge Home Assistant Addon

This addon provides a functionality to provide and authenticate users via LDAP which are authenticated against an IMAP server.
Users and assigned groups are configured in a JSON file.

A configuration file named `config.json` must be provided in the directory `addon_configs/xxx_ldap-imap-bridge/`.
Following an example for the configuration file:

```json
{
    "baseDn": "dc=example, dc=com",
    "userDn": "ou=people, dc=example, dc=com",
    "groupDn": "ou=groups, dc=example, dc=com",
    "organization": "EXAMPLE INC",
    "domain": "example",
    "bindDn": "cn=admin, dc=example, dc=com",
    "bindPassword": "123456",
    "port": 1389  ,
    "dataFile": "/config/data/data.json",
    "imap": {
        "hostname": "imap.example.com",
        "port": 993,
        "useTLS": true
    }
}
```

As definded in the config.json file the users and groups are defined in the `data.json` file. This must be located in the directory `addon_configs/xxx_ldap-imap-bridge/data/`

Following an example for the file `data.jso`:

```json
{
  "users": [
    {
      "dn": "cn=tester,ou=people,dc=example,dc=com",
      "attributes": {
        "objectclass": [
          "top",
          "organizationalPerson",
          "person",
          "inetOrgPerson"
        ],
        "cn": ["tester"],
        "displayName": ["Tester"],
        "sn": ["Master"],
        "givenName": ["Tester"],
        "uid": ["tester"],
        "homePhone": ["+1 123 123456"],
        "mobile": ["+1 123 123457"],
        "mail": ["tester.master@example.com"],
        "preferredLanguage": ["en"],
        "postalCode": ["123456"],
        "street": ["Street No. 1"],
        "quota": ["10G"],
        "userPassword": ["{SSHA}Zhg7juGDKLKLKHT="],
        "postalAdress": ["City"],
        "lastPasswordUpdate": "2023-02-12T11:18:29.149Z"
      }
    }
  ],
  "groups": [
    {
      "dn": "cn=admin,ou=groups,dc=example,dc=com",
      "attributes": {
        "ou": "Administrators",
        "uniqueMember": [
          "cn=tester,ou=people,dc=example,dc=com"
        ],
        "cn": "admin",
        "objectclass": ["top", "groupOfUniqueNames"],
        "description": "Adminitrators"
      }
    }
  ]
}
````
