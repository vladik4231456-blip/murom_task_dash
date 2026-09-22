import tempfile
import unittest
from pathlib import Path

import app as app_module


class EmailVerificationTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        app_module.DB_PATH = Path(self.tmpdir.name) / 'test.sqlite'
        app_module.init_db()
        self.client = app_module.app.test_client()

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_registration_rejects_invalid_email(self):
        response = self.client.post(
            '/api/auth/register',
            json={'name': 'Тест User', 'email': 'nope', 'password': 'secret123'},
        )
        self.assertEqual(response.status_code, 400)
        self.assertIn('корректный email', response.get_json()['message'])


if __name__ == '__main__':
    unittest.main()
