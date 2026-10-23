import { createContext } from 'react';
import { ARM_SOFT_LIMIT_RATIO } from '../lib/robotJointLimits.js';

// One project setting shared by the live scene, pose previews and offline jobs.
export const RobotJointLimitContext = createContext(ARM_SOFT_LIMIT_RATIO);
export const RobotJointCouplingContext = createContext(true);
