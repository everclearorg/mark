import { reset, restore } from 'sinon';

import chai from 'chai';
import promised from 'chai-as-promised';
import subset from 'chai-subset';

let chaiPlugin = chai.use(promised);
chaiPlugin.use(subset);
export const expect = chaiPlugin.expect;

export const mochaHooks = {
  beforeEach() { },

  afterEach() {
    restore();
    reset();
  },
};
