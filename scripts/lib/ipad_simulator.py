#!/usr/bin/env python3
"""Launch Atlas in the shared iPad Pro simulator instance."""

from apple_simulator import IPAD, main


if __name__ == '__main__':
    raise SystemExit(main(IPAD))
