"""NIP-19/NIP-05 public contact parsing, separate from Marmot cryptography."""
import http.client
import ipaddress
import json
import re
import socket
import ssl
from urllib.parse import quote
from vendor.bech32 import bech32_decode, bech32_encode, convertbits
from engine import EngineError

HEX = re.compile(r'[0-9a-f]{64}\Z')
USER = re.compile(r'[a-zA-Z0-9_.-]{1,64}\Z')
LABEL = re.compile(r'[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\Z')
TLD = re.compile(r'[a-zA-Z]{2,63}\Z')

class _Domain:
    # Label by label, so a long hostile string can't make the pattern backtrack (CodeQL, 27 Oct 2026).
    @staticmethod
    def fullmatch(value):
        if not isinstance(value, str) or not 1 <= len(value) <= 253: return False
        *labels, tld = value.split('.')
        return bool(labels) and all(LABEL.match(l) for l in labels) and bool(TLD.match(tld))

DOMAIN = _Domain()

def npub_encode(key):
    if not isinstance(key,str) or not HEX.fullmatch(key):
        raise EngineError('invalid_public_key','Invalid public contact key',400)
    words=convertbits(bytes.fromhex(key),8,5,True)
    assert words is not None
    return bech32_encode('npub',words)

def nprofile_encode(key, relays):
    body=bytes([0,32])+bytes.fromhex(key)
    for relay in relays[:4]:
        data=relay.encode()
        if len(data)<=255 and relay.startswith('wss://'):
            body+=bytes([1,len(data)])+data
    words=convertbits(body,8,5,True)
    assert words is not None
    return bech32_encode('nprofile',words)

def decode_address(value):
    if not isinstance(value,str) or not value or len(value)>4096 or value!=value.strip():
        raise EngineError('invalid_address','Paste a public Messenger address',400)
    if value.startswith('nostr:'):
        value=value[6:]
    if HEX.fullmatch(value):
        return {'pubkey':value,'npub':npub_encode(value),'relays':[]}
    if value.startswith(('npub1','nprofile1')):
        if value!=value.lower():
            raise EngineError('invalid_address','Use the lowercase contact code',400)
        hrp,words=bech32_decode(value)
        data=convertbits(words,5,8,False) if words is not None else None
        if hrp not in ['npub','nprofile'] or data is None:
            raise EngineError('invalid_address','That contact code has an invalid checksum',400)
        raw=bytes(data)
        if hrp=='npub':
            if len(raw)!=32: raise EngineError('invalid_address','Invalid public key length',400)
            return {'pubkey':raw.hex(),'npub':value,'relays':[]}
        keys=[]; relays=[]; pos=0
        while pos<len(raw):
            if pos+2>len(raw): raise EngineError('invalid_address','Incomplete contact code',400)
            typ,size=raw[pos],raw[pos+1]; pos+=2
            if pos+size>len(raw): raise EngineError('invalid_address','Incomplete contact code',400)
            item=raw[pos:pos+size]; pos+=size
            if typ==0: keys.append(item)
            if typ==1:
                try: relay=item.decode('utf-8')
                except UnicodeError: raise EngineError('invalid_address','Invalid relay hint',400) from None
                if not relay.startswith('wss://') or len(relay)>255 or '\x00' in relay:
                    raise EngineError('invalid_address','Invalid relay hint',400)
                relays.append(relay)
        if len(keys)!=1 or len(keys[0])!=32:
            raise EngineError('invalid_address','Contact code must contain one public key',400)
        return {'pubkey':keys[0].hex(),'npub':npub_encode(keys[0].hex()),'relays':relays}
    raise EngineError('invalid_address','Use an npub, nprofile or name@domain address',400)

class PinnedHTTPS(http.client.HTTPSConnection):
    """Connect only to previously checked public DNS answers; retain TLS hostname."""
    def connect(self):
        answers=socket.getaddrinfo(self.host,443,type=socket.SOCK_STREAM)
        if not answers or any(not ipaddress.ip_address(answer[4][0]).is_global for answer in answers):
            raise EngineError('address_lookup_forbidden','This domain is not a public address provider',400)
        last=None
        for family,typ,proto,_,sockaddr in answers:
            connection=socket.socket(family,typ,proto)
            connection.settimeout(self.timeout)
            try:
                connection.connect(sockaddr)
                self.sock=ssl.create_default_context().wrap_socket(connection,server_hostname=self.host)
                return
            except OSError as e:
                connection.close(); last=e
        raise OSError('Address provider connection failed') from last

def resolve(value):
    if not isinstance(value,str): raise EngineError('invalid_address','Paste a public Messenger address',400)
    if '@' not in value: return decode_address(value)
    if value!=value.strip() or value.count('@')!=1:
        raise EngineError('invalid_address','Invalid name@domain address',400)
    name,domain=value.split('@')
    if not USER.fullmatch(name) or not DOMAIN.fullmatch(domain):
        raise EngineError('invalid_address','Invalid name@domain address',400)
    name=name.lower(); domain=domain.lower()
    connection=PinnedHTTPS(domain,timeout=6)
    try:
        connection.request('GET','/.well-known/nostr.json?name='+quote(name,safe=''),headers={'Accept':'application/json','User-Agent':'Wizard-Messenger/0.1'})
        response=connection.getresponse()
        if response.status!=200:
            raise EngineError('address_not_found','Could not find that handle; paste their contact code instead',404)
        raw=response.read(65537)
        if len(raw)>65536: raise ValueError('Too large')
        data=json.loads(raw)
        key=data.get('names',{}).get(name)
        if not isinstance(key,str) or not HEX.fullmatch(key):
            raise EngineError('address_not_found','That handle does not map to a valid public key',404)
        relays=data.get('relays',{}).get(key,[])
        relays=[r for r in relays if isinstance(r,str) and r.startswith('wss://') and len(r)<=255][:4] if isinstance(relays,list) else []
        return {'pubkey':key,'npub':npub_encode(key),'relays':relays,'nip05':value,'nip05_verified':True}
    except EngineError: raise
    except (OSError,ValueError,TypeError,AttributeError,http.client.HTTPException):
        raise EngineError('address_lookup_failed','Could not look up that handle; paste their contact code instead',502) from None
    finally: connection.close()
