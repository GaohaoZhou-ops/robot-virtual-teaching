#!/usr/bin/env python3
"""Launch Atlas in the shared visionOS simulator instance."""

from apple_simulator import VISION, main


if __name__ == '__main__':
    raise SystemExit(main(VISION))
