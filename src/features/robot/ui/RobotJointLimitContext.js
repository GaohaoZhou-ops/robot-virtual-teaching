import { createContext } from 'react';
import { ARM_SOFT_LIMIT_RATIO } from "../model/robotJointLimits.js";

// One project setting shared by the live scene, pose previews and offline jobs.
export const RobotJointLimitContext = createContext(ARM_SOFT_LIMIT_RATIO);
export const RobotJointSoftRangesContext = createContext(Object.freeze({}));
export const RobotJointCouplingContext = createContext(true);
