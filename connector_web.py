"""Owner-only HTTP boundary for connector administration (including status).

Install this handler with ConnectorInbox together. A time-limited agent grant
never authorizes provisioning, QR retrieval, account linking or disconnect.
"""
from urllib.parse import urlsplit
from engine import EngineError
from web import ViewHandler


class ConnectorViewHandler(ViewHandler):
    def _dispatch(self, method):
        path = urlsplit(self.path).path
        if (path == '/api/unified/connectors' or path.startswith('/api/unified/connectors/')
                or path.startswith('/api/unified/telegram/')):
            if self.headers.get('Authorization') or not self._session():
                raise EngineError('owner_required', 'Only an owner browser session may administer network accounts', 403)
            # Parent also checks Origin/CSRF for POST before dispatching to inbox.
        return super()._dispatch(method)
