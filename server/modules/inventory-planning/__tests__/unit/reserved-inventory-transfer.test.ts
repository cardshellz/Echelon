import { describe, it, expect } from "vitest";
import { selectReservedTransferGroups } from "../../domain/reserved-inventory-transfer";
describe("whole unpicked reservation transfer planning", () => {
  it("leaves claims alone when free stock covers the move", () => expect(selectReservedTransferGroups([{
    orderItemId: 1, quantity: 3
  }], 2, 2)).toEqual([]));
  it("moves a whole line instead of splitting the minimum reserved spillover", () => expect(selectReservedTransferGroups([{
    orderItemId: 1, quantity: 3
  }], 3, 2)).toEqual([{
    orderItemId: 1, quantity: 3
  }]));
  it("can select a later whole line that fits the requested transfer", () => expect(selectReservedTransferGroups([{
    orderItemId: 1, quantity: 3
  }, {
    orderItemId: 2, quantity: 1
  }], 1, 0)).toEqual([{
    orderItemId: 2, quantity: 1
  }]));
  it("refuses a quantity that would split the pick line", () => expect(() => selectReservedTransferGroups([{
    orderItemId: 1, quantity: 3
  }], 2, 1)).toThrow('complete unpicked line'));
  it.each([0, -1, 1.5, NaN])("rejects invalid transfer quantity %s", quantity => expect(() => selectReservedTransferGroups([], quantity, 0)).toThrow());
});
describe("whole-line combinations", () => {
  it("does not greedily strand a later exact fit", () => {
    expect(selectReservedTransferGroups([{
      orderItemId: 1, quantity: 2
    }, {
      orderItemId: 2, quantity: 3
    }], 3, 0))
      .toEqual([{
        orderItemId: 2, quantity: 3
      }]);
  });
  it("finds multiple later lines when the first fitting line would strand the quantity", () => {
    expect(selectReservedTransferGroups([{
      orderItemId: 1, quantity: 3
    }, {
      orderItemId: 2, quantity: 2
    }, {
      orderItemId: 3, quantity: 2
    }], 4, 0))
      .toEqual([{
        orderItemId: 2, quantity: 2
      }, {
        orderItemId: 3, quantity: 2
      }]);
  });
  it.each([0, -1, 1.2, 2147483648])("rejects invalid order identity %s", orderItemId => {
    expect(() => selectReservedTransferGroups([{
      orderItemId, quantity: 1
    }], 1, 0)).toThrow();
  });
  it("refuses duplicate order identities", () => {
    expect(() => selectReservedTransferGroups([{
      orderItemId: 1, quantity: 1
    }, {
      orderItemId: 1, quantity: 1
    }], 2, 0)).toThrow();
  });
  it("bounds unusual whole-line combination searches", () => {
    const groups = Array.from({
      length: 17
    }, (_, index) => ({
      orderItemId: index + 1, quantity: 2 ** (index + 1)
    }));
    expect(() => selectReservedTransferGroups(groups, 200001, 0)).toThrow("too many whole-line combinations");
  });
});
