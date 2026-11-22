import unittest
from tax import tax

class TaxTest(unittest.TestCase):
    def test_rate(self):
        self.assertEqual(tax(100), 20)

if __name__ == '__main__':
    unittest.main()
