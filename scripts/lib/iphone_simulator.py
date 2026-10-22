#!/usr/bin/env python3
"""Launch Atlas in the shared iPhone simulator instance."""

from apple_simulator import IPHONE, main


if __name__ == '__main__':
    raise SystemExit(main(IPHONE))
