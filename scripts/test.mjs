console.log("Hello world")

function f1(a) {
    console.log(a + " f1")
    function f2(b) {
        console.log(a + "f2")
        console.log(b + "f2")
    }
}

let zz = { a: 1, b: 2 }
for(const j of zz) {
    console.log(j)
}