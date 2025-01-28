import { reset, restore } from 'sinon';

import chai from 'chai';
import promised from 'chai-as-promised';

let chaiPlugin = chai.use(promised);
export const expect = chaiPlugin.expect;

export const mochaHooks = {
  beforeEach() { },

  afterEach() {
    restore();
    reset();
  },
};
