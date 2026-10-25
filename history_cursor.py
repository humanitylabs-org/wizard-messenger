"""Scoped stable timestamp + message-id history cursors (not authorization)."""
import base64
import json


def encode(person, timestamp, message_id):
    return base64.urlsafe_b64encode(json.dumps([person, timestamp, message_id]).encode()).decode()


def decode(cursor, person):
    try:
        if not isinstance(cursor, str) or len(cursor) > 2048:
            raise ValueError()
        data = json.loads(base64.b64decode(cursor, altchars=b'-_', validate=True))
        if (not isinstance(data, list) or len(data) != 3 or data[0] != person
                or type(data[1]) is not int or not 0 <= data[1] <= 9223372036854775807
                or not isinstance(data[2], str) or not 0 < len(data[2]) <= 512):
            raise ValueError()
        return data[1], data[2]
    except (ValueError, TypeError, UnicodeError):
        raise ValueError('Invalid or differently scoped history cursor') from None
