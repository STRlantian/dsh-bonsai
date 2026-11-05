console.log("Hello world")

function f1(a) {
    console.log(a + " f1")
    function f2(b) {
        console.log(a + "f2")
        console.log(b + "f2")
    }
}

class Test {

    constructor(a, b) {
        this.a = a
        this.b = b
    }

    test() {
        console.log("azzzzz")
        console.log(this.a + this.b)
    }
}
let a = new Test(1, 2)
a.test()